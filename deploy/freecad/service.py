import base64

from sandbox import run, result, LIMIT
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
MAX_REQUEST = 36 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def address_string(self):
        return "local"

    def setup(self):
        super().setup()
        self.connection.settimeout(35)

    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()

    def respond(self, status, data):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path not in ("/linkage", "/design"):
            return self.send_error(404)
        if not slot.acquire(blocking=False):
            return self.send_error(503, "FreeCAD is busy")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_REQUEST:
                return self.send_error(413)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                return self.send_error(400)
            with tempfile.TemporaryDirectory() as temp:
                folder = Path(temp)
                if "source" in body:
                    original = base64.b64decode(body.pop("source"), validate=True)
                    if len(original) > LIMIT:
                        return self.send_error(413)
                    (folder / "source.FCStd").write_bytes(original)
                if self.path == "/linkage":
                    distance = body["distance"]
                    if type(distance) not in (int,float) or not math.isfinite(distance) or not 40 <= distance <= 2000:
                        return self.send_error(400)
                    run(folder, "linkage.py", "/work", str(distance))
                    data = {ext:base64.b64encode(result(folder, "linkage."+ext)).decode() for ext in ("FCStd","glb")}
                else:
                    data = design(folder, body)
            self.respond(200, data)
        except (TypeError, KeyError, ValueError, OSError, subprocess.TimeoutExpired) as exc:
            self.respond(422, {"error":str(exc)[-2400:]})
        finally:
            slot.release()


def design(folder, body):
    action = body["action"]
    if action not in ("inspect","create","edit") or (folder / "source.FCStd").exists() != (action != "create"):
        raise ValueError("Select an existing FCStd for inspect or edit, or create a new document")
    if action == "inspect":
        run(folder, "design.py", "inspect")
        return {"report": json.loads(result(folder, "report.json", 256*1024))}
    code = body["code"]
    if not isinstance(code,str) or not 0 < len(code) <= 64000:
        raise ValueError("Expected a modelling script up to 64000 characters")
    paths = {}
    for index, reference in enumerate(body.get("references", [])):
        name = reference["name"]
        suffix = Path(name).suffix.lower()
        if index >= 8 or suffix not in (".fcstd",".stp",".step",".brep",".dxf") or name in paths:
            raise ValueError("Unsupported or duplicate CAD reference")
        file = folder / ("reference-" + str(index) + suffix)
        file.write_bytes(base64.b64decode(reference["data"], validate=True))
        paths[name] = "/work/" + file.name
    (folder / "inputs.json").write_text(json.dumps(paths))
    (folder / "design.py").write_text(code, encoding="utf8")
    run(folder, "design.py", action)
    native = result(folder, "model.FCStd")
    # Reopen the native output in an independent process, without the modelling script.
    with tempfile.TemporaryDirectory() as validation:
        clean = Path(validation)
        (clean / "model.FCStd").write_bytes(native)
        root = body.get("bomRoot")
        if root and (not isinstance(root,str) or not root.isidentifier() or len(root)>100):
            raise ValueError("Invalid BOM root object name")
        run(clean, "design.py", "export", *([root] if root else []))
        data = {"FCStd":base64.b64encode(native).decode(),
                "glb":base64.b64encode(result(clean,"model.glb")).decode(),
                "report":json.loads(result(clean,"report.json",256*1024))}
        if root:
            data["bom"] = json.loads(result(clean,"bom.json",1024*1024))
        return data


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
