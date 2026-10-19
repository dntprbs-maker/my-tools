"""Real HTTP parsing/serialization without network sockets.

Images use a valid 1x1 PNG. Server format recognition is signature-only;
these tests do not certify complete image decoding or malformed-image safety.
"""
import base64
from contextlib import redirect_stdout
from email.parser import BytesParser
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=')


class FakeSocket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def makefile(self, mode, *args):
        assert mode == 'rb'
        return self.input

    def sendall(self, data):
        self.output.extend(data)


class WireTests(unittest.TestCase):
    def test_mobile_disconnect_before_next_request(self):
        class ResetStream(io.BytesIO):
            def readline(self, *args):
                raise ConnectionResetError('synthetic mobile socket reset')
        socket = FakeSocket(b'')
        socket.input = ResetStream()
        with redirect_stdout(io.StringIO()):
            handler = server.Handler(socket, ('127.0.0.1', 54321), self.httpserver)
        self.assertTrue(handler.close_connection)
        self.assertEqual(socket.output, bytearray())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'evidence')
        self.store = server.Store(self.temp.name)
        self.httpserver = SimpleNamespace(store=self.store, failure_lock=threading.Lock(), failures={})

    def tearDown(self):
        self.temp.cleanup()

    def request(self, path, body=None, auth=None, extra=None, raw=None):
        payload = json.dumps(body, ensure_ascii=False).encode() if body is not None else b''
        headers = {'Host': 'localhost:8791', 'Connection': 'close'}
        method = 'POST' if body is not None else 'GET'
        if body is not None:
            headers.update({'Content-Type': 'application/json', 'Content-Length': str(len(payload))})
        if auth:
            headers.update({'Cookie': auth[0], 'X-CSRF-Token': auth[1]})
        headers.update(extra or {})
        wire = (f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{key}: {value}\r\n' for key, value in headers.items()) + '\r\n').encode() + payload
        sock = FakeSocket(raw if raw is not None else wire)
        with redirect_stdout(io.StringIO()):
            server.Handler(sock, ('127.0.0.1', 54321), self.httpserver)
        head, content = bytes(sock.output).split(b'\r\n\r\n', 1)
        firstline, fields = head.split(b'\r\n', 1)
        status = int(firstline.split()[1])
        responseheaders = BytesParser().parsebytes(fields + b'\r\n\r\n')
        self.assertEqual(int(responseheaders['Content-Length']), len(content), 'response byte length')
        self.assertEqual(responseheaders['Cache-Control'], 'no-store')
        self.assertEqual(responseheaders['X-Content-Type-Options'], 'nosniff')
        if responseheaders['Content-Type'].startswith('application/json'):
            content = json.loads(content)
        return status, responseheaders, content

    def login(self, username='worker', password='Worker-test-2026!'):
        status, headers, body = self.request('/api/login', {'username': username, 'password': password})
        self.assertEqual(status, 200)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        return headers['Set-Cookie'].split(';')[0], body['csrf']

    def action(self, action, auth, body=None):
        status, _, data = self.request('/api/assignments/demo-1/' + action, body or {}, auth)
        self.assertEqual(status, 200, data)
        return data

    def test_full_worker_admin_persistence_wire(self):
        auth = self.login()
        arrived = self.action('arrive', auth)
        self.assertEqual(arrived['log']['status'], 'arrived')
        started = self.action('start', auth)
        self.assertEqual(started['log']['status'], 'working')
        checks = {key: {'status': 'done', 'reason': ''} for key in started['log']['checks']}
        saved = self.action('save', auth, {'version': started['log']['version'], 'checks': checks, 'note': '한글 바이트 길이도 확인'})
        self.assertEqual(saved['log']['note'], '한글 바이트 길이도 확인')
        for stage in ('before', 'after'):
            uploaded = self.action('photos', auth, {'uploadId': f'wire-{stage}-0001', 'stage': stage, 'name': '합성.png', 'content': base64.b64encode(PNG).decode()})
        self.assertEqual(len(uploaded['log']['photos']), 2)
        self.assertEqual(self.action('stop', auth)['log']['status'], 'ended')
        submitted = self.action('submit', auth)
        self.assertEqual(submitted['log']['status'], 'submitted')
        admin = self.login('admin', 'Admin-test-2026!')
        reviewed = self.action('review', admin)
        self.assertEqual(reviewed['log']['status'], 'reviewed')
        self.assertTrue(reviewed['log']['reviewedAt'])
        for photo in reviewed['log']['photos']:
            status, headers, content = self.request(photo['url'], auth=auth)
            self.assertEqual((status, headers['Content-Type'], content), (200, 'image/png', PNG))
            self.assertEqual(self.request(photo['url'])[0], 401)
        worker2 = self.login('worker2', 'Worker2-test-2026!')
        other = self.login('other', 'Other-test-2026!')
        for denied in (worker2, other):
            self.assertEqual(self.request('/api/assignments/demo-1', auth=denied)[0], 404)
            self.assertEqual(self.request(reviewed['log']['photos'][0]['url'], auth=denied)[0], 404)
        # Recreate Store and replay HTTP reads against persisted cookies/DB/files.
        self.store = server.Store(self.temp.name)
        self.httpserver.store = self.store
        status, _, reread = self.request('/api/assignments/demo-1', auth=admin)
        self.assertEqual(status, 200)
        self.assertEqual(reread['log'], reviewed['log'])
        self.assertEqual(reread['audit'], reviewed['audit'])
        for photo in reread['log']['photos']:
            self.assertEqual((Path(self.temp.name) / 'photos' / photo['id']).read_bytes(), PNG)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM photos').fetchone()[0], 2)
            persisted = json.loads(db.execute('SELECT data FROM logs WHERE assignment_id=?', ('demo-1',)).fetchone()[0])
            self.assertEqual(persisted['status'], 'reviewed')

    def test_wire_security_headers_csrf_origin_and_request_body(self):
        status, _, health = self.request('/api/health')
        self.assertEqual((status, health['environment']), (200, 'isolated-synthetic-lab'))
        for path, mime in [('/', 'text/html'), ('/app.js', 'text/javascript'), ('/styles.css', 'text/css')]:
            status, headers, content = self.request(path)
            self.assertEqual(status, 200)
            self.assertTrue(headers['Content-Type'].startswith(mime))
            self.assertTrue(content)
            self.assertIn("default-src 'self'", headers['Content-Security-Policy'])
            self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
            self.assertEqual(headers['X-Frame-Options'], 'DENY')
        self.assertEqual(self.request('/api/bootstrap')[0], 401)
        auth = self.login()
        status, _, data = self.request('/api/assignments/demo-1/arrive', {}, (auth[0], ''))
        self.assertEqual((status, data['code']), (403, 'csrf'))
        status, _, data = self.request('/api/assignments/demo-1/arrive', {}, auth, {'Origin': 'https://evil.example'})
        self.assertEqual((status, data['code']), (403, 'origin'))
        self.assertEqual(self.request('/api/assignments/demo-1/arrive', {}, auth, {'Origin': 'http://localhost:8791'})[0], 200)
        self.assertEqual(self.request('/api/logout', {}, auth)[0], 200)
        self.assertEqual(self.request('/api/me', auth=auth)[0], 401)
        for length, payload, expected in [('3', b'{', 400), ('-1', b'', 413), ('99999999', b'', 413), ('abc', b'{}', 400)]:
            wire = f'POST /api/login HTTP/1.1\r\nHost: localhost:8791\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {length}\r\n\r\n'.encode() + payload
            self.assertEqual(self.request('/', raw=wire)[0], expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
