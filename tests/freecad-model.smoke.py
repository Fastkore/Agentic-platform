# Sidecar smoke test to run with /usr/bin/python3 in the FreeCAD image.
import json
from pathlib import Path
import struct
import tempfile

import FreeCAD as App
from linkage import check_document, generate

with tempfile.TemporaryDirectory() as directory:
    folder = Path(directory)
    generate(folder, 86)
    first = App.openDocument(str(folder / 'linkage.FCStd'))
    first.Parameters.addProperty('App::PropertyString','ReviewNote')
    first.Parameters.ReviewNote = 'Preserve this native document edit'
    first.saveAs(str(folder / 'source.FCStd'))
    App.closeDocument(first.Name)
    generate(folder, 100)
    second = App.openDocument(str(folder / 'linkage.FCStd'))
    check_document(second, 100)
    assert second.Parameters.ReviewNote == 'Preserve this native document edit'
    # Check that both eyes and the rod web physically span the requested length.
    assert abs(second.Rod.Shape.BoundBox.XLength - 126) < 0.02
    assert abs(second.RightBolt.Shape.optimalBoundingBox(False).Center.x - 100) < 0.02
    second.Parameters.PivotDistance = 120
    second.recompute()
    check_document(second, 120)
    assert abs(second.Rod.Shape.BoundBox.XLength - 146) < 0.02
    App.closeDocument(second.Name)
    glb = (folder / 'linkage.glb').read_bytes()
    magic, version, length, json_size, chunk = struct.unpack_from('<4sIII4s',glb)
    assert (magic,version,length,chunk) == (b'glTF',2,len(glb),b'JSON')
    scene = json.loads(glb[20:20+json_size])
    assert len(scene['nodes']) == 11
    rod = next(n for n in scene['nodes'] if n['name'] == 'Rod')
    pos = scene['meshes'][rod['mesh']]['primitives'][0]['attributes']['POSITION']
    accessor = scene['accessors'][pos]
    assert abs(accessor['max'][0]-accessor['min'][0]-.126)<.0001
    print('Native document edit preserved. FCStd 86 -> 100 -> 120 mm; GLB 11 components, 126 mm rod.')
