"""Synthetic Store and HTTP handler tests; no sockets or production data."""
import base64
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

PNG = b'\x89PNG\r\n\x1a\n' + b'synthetic-test-payload'


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / 'evidence')
        self.store = server.Store(self.temp.name)
        with self.store.connect() as db:
            self.worker = self.store.user(db, 'w1')
            self.admin = self.store.user(db, 'a1')
            self.otherworker = self.store.user(db, 'w2')
            self.othercompany = self.store.user(db, 'b1')

    def tearDown(self):
        self.temp.cleanup()

    def action(self, action, body=None, aid='demo-1', user=None):
        with self.store.connect() as db:
            return self.store.mutate(db, user or self.worker, aid, action, body or {})

    def detail(self, aid='demo-1', user=None):
        with self.store.connect() as db:
            return self.store.detail(db, user or self.worker, aid)

    def photo(self, stage='before', upload='upload-0001', raw=PNG, **extra):
        with self.store.connect() as db:
            return self.store.photo(db, self.worker, 'demo-1', dict(uploadId=upload, stage=stage, name='test.png', content=base64.b64encode(raw).decode(), **extra))

    def error(self, code, func, *args, **kwargs):
        with self.assertRaises(server.Problem) as context:
            func(*args, **kwargs)
        self.assertEqual(context.exception.code, code)
        return context.exception

    def ended(self):
        for action in ('arrive', 'start', 'stop'):
            self.action(action)

    def save_done(self, skipped=False):
        log = self.detail()['log']
        checks = {key: {'status': 'done', 'reason': ''} for key in log['checks']}
        if skipped:
            checks['floor'] = {'status': 'skipped', 'reason': '검증용 출입 제한'}
        return self.action('save', dict(version=log['version'], checks=checks, note='검증 메모'))

    def submitted(self):
        self.ended()
        self.save_done()
        self.photo()
        self.photo('after', 'upload-0002')
        return self.action('submit')

    def test_assignment_company_and_worker_permissions(self):
        self.assertEqual(self.detail()['workerId'], 'w1')
        self.assertEqual(self.detail(user=self.admin)['id'], 'demo-1')
        self.error('not_found', self.detail, user=self.otherworker)
        self.error('not_found', self.detail, user=self.othercompany)
        self.error('not_found', self.detail, aid='demo-4', user=self.admin)
        self.assertEqual(self.error('invalid', self.action, 'arrive', user=self.admin).status, 403)
        self.action('arrive')
        self.assertEqual(self.error('invalid', self.action, 'review').status, 403)

    def test_arrive_start_stop_idempotency_and_open_work(self):
        for action, status in [('arrive', 'arrived'), ('start', 'working'), ('stop', 'ended')]:
            first = self.action(action)
            second = self.action(action)
            self.assertEqual(first['log'], second['log'])
            self.assertEqual(first['audit'], second['audit'])
            self.assertEqual(second['log']['status'], status)
            if action == 'start':
                self.action('arrive', aid='demo-2')
                self.error('open_work', self.action, 'start', aid='demo-2')
        self.assertEqual(self.action('start', aid='demo-2')['log']['status'], 'working')

    def test_invalid_transitions_and_optimistic_version(self):
        self.error('state', self.action, 'start')
        self.action('arrive')
        self.error('state', self.action, 'stop')
        self.error('state', self.action, 'submit')
        self.error('state', self.action, 'review', user=self.admin)
        first = self.save_done()
        self.error('version_conflict', self.action, 'save', dict(version=1, checks=first['log']['checks']))
        self.error('invalid', self.action, 'save', dict(version=first['log']['version'], checks={}))

    def test_submit_checks_skipped_reason_and_photo_gates(self):
        self.ended()
        self.error('missing_checks', self.action, 'submit')
        log = self.detail()['log']
        checks = {key: {'status': 'done', 'reason': ''} for key in log['checks']}
        checks['floor']['status'] = 'skipped'
        self.action('save', dict(version=log['version'], checks=checks))
        self.error('missing_checks', self.action, 'submit')
        self.save_done(skipped=True)
        self.error('missing_photos', self.action, 'submit')
        self.photo()
        self.error('missing_photos', self.action, 'submit')
        self.photo('after', 'upload-0002')
        self.assertEqual(self.action('submit')['log']['status'], 'submitted')
        self.error('locked', self.save_done)

    def test_photo_retry_limits_formats_and_ownership(self):
        self.action('arrive')
        first = self.photo()
        duplicate = self.photo(raw=b'ignored-on-retry')
        self.assertEqual(first['log']['photos'], duplicate['log']['photos'])
        self.assertEqual(len(duplicate['log']['photos']), 1)
        self.error('invalid', self.photo, upload='upload-badfmt', raw=b'GIF89a')
        self.assertEqual(self.error('invalid', self.photo, upload='upload-big', raw=PNG + b'x' * (5*1024*1024)).status, 413)
        self.error('invalid', self.photo, upload='upload-item', itemId='foreign')
        self.photo(upload='upload-jpeg', raw=b'\xff\xd8\xfftest')
        self.photo(upload='upload-webp', raw=b'RIFF1234WEBPtest')
        for index in range(3, 12):
            self.photo(upload=f'upload-{index:04}')
        self.assertEqual(self.error('invalid', self.photo, upload='upload-limit').status, 413)
        with self.store.connect() as db:
            self.error('not_found', self.store.photo, db, self.otherworker, 'demo-1', {})

    def test_return_resubmit_review_and_correction_audit(self):
        original = self.submitted()
        self.action('return', {'reason': '추가 확인 필요'}, user=self.admin)
        self.save_done(skipped=True)
        self.assertEqual(self.action('submit')['log']['status'], 'submitted')
        reviewed = self.action('review', user=self.admin)
        self.assertEqual(reviewed['log']['status'], 'reviewed')
        self.assertEqual(self.action('review', user=self.admin)['audit'], reviewed['audit'])
        corrected = self.action('correct', dict(startedAt=original['log']['startedAt'], endedAt=original['log']['endedAt'], reason='검증 정정'), user=self.admin)
        entry = corrected['audit'][-1]
        self.assertEqual(entry['action'], '실제 시각 정정')
        self.assertEqual(entry['before']['startedAt'], original['log']['startedAt'])
        self.assertEqual(entry['reason'], '검증 정정')
        self.error('invalid', self.action, 'correct', dict(startedAt='2030-01-02T00:00:00Z', endedAt='2030-01-01T00:00:00Z', reason='역전'), user=self.admin)
        self.error('invalid', self.action, 'correct', dict(startedAt='2000-01-01T00:00:00Z', endedAt='2030-01-01T00:00:00Z', reason='도착 이전'), user=self.admin)

    def test_schedule_promise_separation_and_confirmation(self):
        original = self.detail()
        body = dict(kind='schedule', plannedStart='2030-02-01T19:00:00+09:00', plannedEnd='2030-02-01T21:00:00+09:00', reason='실행시간 조정', customer={'confirmed': False})
        scheduled = self.action('adjust', body, user=self.admin)
        for key in ('promiseDate', 'period', 'promiseVersion', 'occurrenceId'):
            self.assertEqual(original[key], scheduled[key])
        self.assertFalse(scheduled['lastCustomerConfirmation']['confirmed'])
        body.update(kind='promise', promiseDate='2030-02-02', period='PM')
        self.error('invalid', self.action, 'adjust', body, user=self.admin)
        body['customer'] = dict(confirmed=True, name='테스트 고객', method='전화', at='2030-01-01T10:00:00+09:00', evidence='테스트 확인')
        changed = self.action('adjust', body, user=self.admin)
        self.assertEqual((changed['promiseDate'], changed['period'], changed['promiseVersion']), ('2030-02-02', 'PM', 2))
        self.assertEqual(changed['occurrenceId'], original['occurrenceId'])
        body['plannedEnd'] = '2029-01-01T10:00:00Z'
        self.error('invalid', self.action, 'adjust', body, user=self.admin)

    def test_assignment_creation_validation_and_duplicate(self):
        body = dict(siteId='s1', workerId='w1', promiseDate='2031-01-01', period='AM', plannedStart='2031-01-01T05:00:00+09:00', plannedEnd='2031-01-01T07:00:00+09:00')
        with self.store.connect() as db:
            self.assertEqual(self.error('invalid', self.store.create_assignment, db, self.worker, body).status, 403)
            created = self.store.create_assignment(db, self.admin, body)
            self.assertEqual(created['promiseDate'], '2031-01-01')
            self.assertTrue(created['occurrenceId'])
        import sqlite3
        with self.assertRaises(sqlite3.IntegrityError):
            with self.store.connect() as db:
                self.store.create_assignment(db, self.admin, body)
        for changes in ({'workerId': 'b1'}, {'workerId': 'i1'}, {'siteId': 'sb'}, {'promiseDate': '2031-02-30'}, {'plannedEnd': '2030-01-01T00:00:00Z'}, {'plannedStart': '2031-01-01T05:00:00'}):
            with self.store.connect() as db:
                self.error('invalid', self.store.create_assignment, db, self.admin, {**body, **changes})

    def test_midnight_nine_boundary_and_persistence(self):
        original = self.detail()
        for instant, action in [('2030-01-01T14:59:59.000+00:00', 'arrive'), ('2030-01-01T15:00:01.000+00:00', 'start'), ('2030-01-02T00:00:01.000+00:00', 'stop')]:
            with patch.object(server, 'now', return_value=instant):
                result = self.action(action)
            self.assertEqual(result['promiseDate'], original['promiseDate'])
            self.assertEqual(result['period'], original['period'])
            self.assertEqual(result['occurrenceId'], original['occurrenceId'])
        self.assertEqual(result['log']['elapsedSeconds'], 32400)
        self.photo()
        self.store = server.Store(self.temp.name)
        reopened = self.detail()
        self.assertEqual(reopened['log']['endedAt'], result['log']['endedAt'])
        self.assertEqual(len(reopened['log']['photos']), 1)
        photoid = reopened['log']['photos'][0]['id']
        self.assertEqual((Path(self.temp.name) / 'photos' / photoid).read_bytes(), PNG)

    def request(self, path, body=None, cookie='', csrf='', origin=None):
        handler = object.__new__(server.Handler)
        handler.server = SimpleNamespace(store=self.store, failure_lock=threading.Lock(), failures={})
        handler.path = path
        handler.command = 'POST' if body is not None else 'GET'
        handler.client_address = ('127.0.0.1', 12345)
        raw = json.dumps(body).encode() if body is not None else b''
        handler.headers = {'Content-Type': 'application/json', 'Content-Length': str(len(raw)), 'Cookie': cookie, 'X-CSRF-Token': csrf, 'Host': 'localhost:8791'}
        if origin:
            handler.headers['Origin'] = origin
        handler.rfile = io.BytesIO(raw)
        response = {}
        def capture(status, data, mime=None, cookie=None):
            if status < 400 and handler.request_db is not None:
                handler.request_db.commit()
            response.update(status=status, data=data, cookie=cookie)
        handler.send = capture
        handler.handle_request(body is not None)
        return response

    def test_http_login_session_csrf_origin_and_company(self):
        self.assertEqual(self.request('/api/bootstrap')['status'], 401)
        self.assertEqual(self.request('/api/login', {'username': 'inactive', 'password': 'Inactive-test-2026!'})['status'], 401)
        login = self.request('/api/login', {'username': 'worker', 'password': 'Worker-test-2026!'})
        self.assertEqual(login['status'], 200)
        self.assertIn('HttpOnly; SameSite=Strict', login['cookie'])
        cookie, csrf = login['cookie'].split(';')[0], login['data']['csrf']
        bootstrap = self.request('/api/bootstrap', cookie=cookie)
        self.assertEqual({a['id'] for a in bootstrap['data']['assignments']}, {'demo-1', 'demo-2', 'demo-5'})
        self.assertEqual(bootstrap['data']['workers'], [])
        self.assertEqual(self.request('/api/assignments/demo-3', cookie=cookie)['status'], 404)
        self.assertEqual(self.request('/api/assignments/demo-1/arrive', {}, cookie)['status'], 403)
        self.assertEqual(self.request('/api/assignments/demo-1/arrive', {}, cookie, csrf, 'https://evil.example')['status'], 403)
        self.assertEqual(self.request('/api/assignments/demo-1/arrive', {}, cookie, csrf)['status'], 200)
        with self.store.connect() as db:
            self.error('invalid', self.store.photo, db, self.worker, 'demo-1', dict(uploadId='upload-badbase64', stage='before', content='%%%'))
        photoid = self.photo()['log']['photos'][0]['id']
        self.assertEqual(self.request('/api/photos/' + photoid, cookie=cookie)['data'], PNG)
        otherlogin = self.request('/api/login', {'username': 'other', 'password': 'Other-test-2026!'})
        self.assertEqual(self.request('/api/photos/' + photoid, cookie=otherlogin['cookie'].split(';')[0])['status'], 404)
        self.assertEqual(self.request('/api/logout', {}, cookie, csrf)['status'], 200)
        self.assertEqual(self.request('/api/me', cookie=cookie)['status'], 401)


if __name__ == '__main__':
    unittest.main(verbosity=2)
