import base64
from http.server import BaseHTTPRequestHandler
import socket
import socketserver
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

SOCKET = "/run/bridge-freecad/service.sock"
slot = threading.BoundedSemaphore(1)
MAX_REQUEST = 6 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def address_string(self):
        return "local"

    def setup(self):
        super().setup()
        self.connection.settimeout(35)

    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/linkage":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_REQUEST:
                return self.send_error(413)
            body = json.loads(self.rfile.read(length))
            distance = body["distance"]
            if type(distance) not in (int,float) or not math.isfinite(distance) or not 40 <= distance <= 2000:
                return self.send_error(400)
            original = base64.b64decode(body["source"],validate=True) if "source" in body else None
        except (TypeError, KeyError, ValueError):
            return self.send_error(400)
        if not slot.acquire(blocking=False):
            return self.send_error(503, "FreeCAD is busy")
        try:
            with tempfile.TemporaryDirectory() as temp:
                folder = Path(temp)
                if original is not None:
                    (folder / "source.FCStd").write_bytes(original)
                subprocess.run([sys.executable, str(Path(__file__).with_name("linkage.py")), temp, str(distance)],
                               check=True, timeout=35)
                payload = json.dumps({ext:base64.b64encode((folder / ("linkage."+ext)).read_bytes()).decode()
                                      for ext in ("FCStd","glb")}).encode()
            self.send_response(200)
            self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (OSError, subprocess.SubprocessError):
            self.send_error(502, "FreeCAD could not complete the model")
        finally:
            slot.release()


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


if __name__ == "__main__":
    if sys.argv[1:] == ["--health"]:
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(2)
            sock.connect(SOCKET)
            sock.sendall(b"GET /health HTTP/1.0\r\n\r\n")
            sys.exit(0 if b" 200 " in sock.recv(256) else 1)
    # Fail startup when FreeCAD's Python modules or native libraries are unavailable.
    import FreeCAD
    import Part
    path = Path(SOCKET)
    path.unlink(missing_ok=True)
    with Server(SOCKET, Handler) as server:
        path.chmod(0o600)
        server.serve_forever()
