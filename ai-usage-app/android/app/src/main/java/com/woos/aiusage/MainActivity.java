package com.woos.aiusage;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        UsageWorker.schedule(this); // 위젯 자동 새로고침(약 15분마다)
    }

    @Override
    public void onPause() {
        super.onPause();
        // 앱을 나갈 때 마지막 조회값으로 홈 화면 위젯을 갱신한다.
        UsageWidget.updateAll(this);
    }
}
