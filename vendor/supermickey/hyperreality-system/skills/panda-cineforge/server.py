#!/usr/bin/env python3
"""
PandaCineForge HTTP Service — SuperMickey 适配版
启动 PandaCineForge 引擎，暴露 HTTP API 供 Node.js 适配器调用。
"""

import json
import os
import sys
import signal
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# 将引擎目录加入路径
SKILL_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SKILL_DIR))

# 加载引擎（可选依赖，失败时降级）
try:
    import panda_cineforge as pcf
    _ENGINE_AVAILABLE = True
except ImportError as e:
    print(f"[WARN] 无法加载 PandaCineForge 引擎: {e}", file=sys.stderr)
    _ENGINE_AVAILABLE = False

# 加载配置
SYSTEM_MESSAGE = ""
USER_TEMPLATE = ""

def _load_text_file(name: str, default: str = "") -> str:
    path = SKILL_DIR / name
    if path.exists():
        return path.read_text(encoding='utf-8')
    return default

SYSTEM_MESSAGE = _load_text_file("system_message.txt")
USER_TEMPLATE = _load_text_file("user_message_template.txt")

# 全局引擎实例（懒加载）
_engine = None
_engine_lock = threading.Lock()

def get_engine():
    global _engine
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is not None:
            return _engine
        if not _ENGINE_AVAILABLE:
            return None
        _engine = pcf.PandaCineForge(
            system_message=SYSTEM_MESSAGE,
            user_template=USER_TEMPLATE,
        )
        return _engine


class Handler(BaseHTTPRequestHandler):
    """HTTP 请求处理器"""

    def log_message(self, format, *args):
        # 简化日志
        print(f"[HTTP] {self.address_string()} - {format % args}")

    def _send_json(self, data: dict, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def _read_body(self) -> dict:
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            return {}
        body = self.rfile.read(content_length).decode('utf-8')
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            engine = get_engine()
            self._send_json({
                "status": "ok" if engine else "degraded",
                "engine_available": _ENGINE_AVAILABLE,
                "llm_available": engine.llm.available if engine else False,
                "skill_count": len(engine.indexer.skills) if engine else 0,
            })
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        if not _ENGINE_AVAILABLE:
            self._send_json({"error": "engine not available", "status": "error"}, 503)
            return

        engine = get_engine()
        if engine is None:
            self._send_json({"error": "engine initialization failed", "status": "error"}, 503)
            return

        body = self._read_body()

        if self.path == '/recall':
            try:
                result = engine.serve(body)
                self._send_json(result)
            except Exception as e:
                self._send_json({"error": str(e), "status": "error"}, 500)

        elif self.path == '/cold_start':
            try:
                matrix = body.get('matrix')
                enable_innovation = body.get('enable_innovation', False)
                result = engine.cold_start(matrix=matrix, enable_innovation=enable_innovation)
                self._send_json(result)
            except Exception as e:
                self._send_json({"error": str(e), "status": "error"}, 500)

        elif self.path == '/feedback':
            try:
                skill_id = body.get('skill_id')
                outcome = body.get('execution_outcome', 'success')
                score = body.get('quality_score', 80)
                reasons = body.get('failure_reasons')
                corrections = body.get('user_corrections')
                result = engine.report_feedback(skill_id, outcome, score, reasons, corrections)
                self._send_json(result)
            except Exception as e:
                self._send_json({"error": str(e), "status": "error"}, 500)

        elif self.path == '/qa_check':
            try:
                skill_id = body.get('skill_id')
                result = engine.qa_check(skill_id)
                self._send_json(result)
            except Exception as e:
                self._send_json({"error": str(e), "status": "error"}, 500)

        else:
            self._send_json({"error": "not found"}, 404)


def run_server(port: int = 8765):
    server = HTTPServer(('127.0.0.1', port), Handler)
    print(f"[PandaCineForge Service] 启动于 http://127.0.0.1:{port}")
    print(f"[PandaCineForge Service] 引擎可用: {_ENGINE_AVAILABLE}")
    print(f"[PandaCineForge Service] 按 Ctrl+C 停止")

    def shutdown(signum, frame):
        print("\n[PandaCineForge Service] 收到信号，停止服务...")
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    server.serve_forever()


if __name__ == '__main__':
    port = int(os.environ.get('PCF_PORT', '8765'))
    run_server(port)
