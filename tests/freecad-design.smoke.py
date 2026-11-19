"""Run inside the CAD image with the same namespace options as compose.freecad.yaml."""
from base64 import b64decode
import json
import tempfile
from pathlib import Path
from struct import unpack_from

from service import design


def invoke(action, code="", source=None, **extras):
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        if source:
            (work/"source.FCStd").write_bytes(b64decode(source))
        return design(work, dict(action=action,code=code,**extras))


first = invoke("create", """
from pathlib import Path
assert not Path('/run/bridge-freecad/service.sock').exists()
assert not Path('/opt/bridge-office').exists()
r=doc.addObject('App::DocumentObjectGroup','Product')
r.addProperty('App::PropertyString','PartNumber'); r.PartNumber='BRACKET'
b=doc.addObject('Part::Box','Plate')
b.Length,b.Width,b.Height=70,40,8
r.addObject(b)
bind_item(b,'00000000-0000-4000-8000-000000000001','PLATE')
""",bomRoot="Product")
assert first["report"]["components"] == 1
assert first["bom"]["items"]["BRACKET"]["children"] == {"PLATE":1}
glb=b64decode(first["glb"])
scene=json.loads(glb[20:20+unpack_from("<I",glb,12)[0]])
assert scene["nodes"][0]["extras"]["ErpItemId"].endswith("0001")
second=invoke("edit","doc.Plate.Height=12",first["FCStd"],bomRoot="Product")
summary=invoke("inspect",source=second["FCStd"])["report"]
assert summary["parts"][0]["boundsMm"][-1] == 12
assert next(o for o in summary["tree"] if o["name"]=="Plate")["dimensions"]["Length"]==70
try:
    invoke("edit","raise ValueError('invalid dimension')",second["FCStd"])
except ValueError as exc:
    assert 'invalid dimension' in str(exc)
else:
    raise AssertionError("Failed build was published")
print("General CAD create/edit/inspect, BOM, GLB metadata and isolated execution passed")
