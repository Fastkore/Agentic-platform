"""Editable double-clevis linkage, dimensions in millimetres."""
import gzip
import sys
from pathlib import Path

import FreeCAD as App
import Part

from preview import write_glb

V = App.Vector
DISTANCE = "Parameters.PivotDistance"
COLORS = {"Rod": (.31,.59,.48), "Fork": (.20,.46,.65), "Bolt": (.67,.72,.77),
          "Nut": (.78,.57,.27), "Spacer": (.46,.51,.57)}


def make_fork():
    shape = Part.makeBox(7, 34, 42, V(-30,-17,0))
    for z in (0, 34):
        plate = Part.makeBox(30,34,8,V(-30,-17,z))
        shape = shape.fuse(plate).fuse(Part.makeCylinder(17,8,V(0,0,z)))
    shape = shape.cut(Part.makeCylinder(6.5,42))
    for y in (-9, 9):
        shape = shape.cut(Part.makeCylinder(3.3,7,V(-30,y,21),V(1,0,0)))
    return shape.removeSplitter()


def hardware(name):
    shape = Part.Shape()
    path = Path(__file__).with_name(name + ".brep.gz")
    shape.importBrepFromString(gzip.decompress(path.read_bytes()).decode("ascii"))
    return shape


def create_document(distance):
    doc = App.newDocument("Linkage")
    params = doc.addObject("App::DocumentObjectGroup", "Parameters")
    params.Label = "Параметры тяги"
    params.addProperty("App::PropertyLength", "PivotDistance", "Geometry", "Межосевое расстояние")
    params.PivotDistance = distance
    parts = doc.addObject("App::DocumentObjectGroup", "Assembly")
    parts.Label = "Шарнирная тяга"
    bar = doc.addObject("Part::Box", "Web")
    bar.Width, bar.Height = 26, 16
    bar.Placement.Base = V(0,-13,13)
    bar.setExpression("Length", DISTANCE)
    ends, bores = [], []
    for side in ("Left", "Right"):
        for suffix, radius, target in (("Eye",13,ends),("Bore",6.5,bores)):
            cyl = doc.addObject("Part::Cylinder", side+suffix)
            cyl.Radius, cyl.Height = radius, 16
            cyl.Placement.Base = V(0,0,13)
            if side == "Right":
                cyl.setExpression("Placement.Base.x", DISTANCE)
            target.append(cyl)
    blank = doc.addObject("Part::MultiFuse","RodBlank")
    blank.Shapes, blank.Refine = [bar,*ends], True
    rod = blank
    for index, bore in enumerate(bores):
        cut = doc.addObject("Part::Cut", "Rod" if index else "FirstHole")
        cut.Base, cut.Tool, cut.Refine = rod, bore, True
        rod = cut
    parts.addObject(rod)
    for operand in [bar,*ends,*bores,blank,doc.FirstHole]:
        operand.Visibility = False

    spacer = Part.makeCylinder(11.5,5).cut(Part.makeCylinder(6.5,5))
    masters = {}
    for name, shape in (("Fork",make_fork()),("Bolt",hardware("screw")),
                        ("Nut",hardware("nut")),("Spacer",spacer)):
        obj = doc.addObject("Part::Feature", "Left"+name)
        obj.Shape = shape
        if name == "Spacer":
            obj.Placement.Base = V(0,0,8)
        parts.addObject(obj)
        masters[name] = obj
    for side in ("Left","Right"):
        for name,z in (("Fork",0),("Bolt",0),("Nut",0),("Spacer",8),("UpperSpacer",29)):
            if side == "Left" and name != "UpperSpacer":
                continue
            obj = doc.addObject("App::Link", side+name)
            obj.LinkedObject = masters["Spacer" if name == "UpperSpacer" else name]
            obj.LinkPlacement = App.Placement(V(0,0,z), App.Rotation(V(0,0,1),180 if side=="Right" else 0))
            if side == "Right":
                obj.setExpression("LinkPlacement.Base.x", DISTANCE)
            parts.addObject(obj)
    return doc


def check_document(doc, distance):
    if len(doc.Assembly.Group) != 11 or abs(doc.Parameters.PivotDistance.Value - distance) > 1e-6:
        raise ValueError("Unexpected assembly parameters")
    if abs(doc.RightBore.Placement.Base.x-distance)>1e-6 or abs(doc.Web.Length.Value-distance)>1e-6:
        raise ValueError("The rod failed to recompute")
    for obj in doc.Assembly.Group:
        shape = obj.Shape
        if len(shape.Solids) != 1 or not shape.isValid() or shape.Volume <= 0:
            raise ValueError("Invalid component " + obj.Name)
        if obj.Name.startswith("Right") and abs(obj.LinkPlacement.Base.x-distance)>1e-6:
            raise ValueError("Misplaced component " + obj.Name)
    if abs(doc.RightBolt.Shape.optimalBoundingBox(False).ZMax-60) > .1:
        raise ValueError("Incorrect bolt length")


def generate(folder, distance):
    source = folder / "source.FCStd"
    doc = App.openDocument(str(source)) if source.exists() else create_document(distance)
    doc.Parameters.PivotDistance = distance
    doc.recompute()
    result = folder / "linkage.FCStd"
    doc.saveAs(str(result))
    App.closeDocument(doc.Name)
    doc = App.openDocument(str(result))
    doc.recompute()
    check_document(doc, distance)
    items = []
    for obj in doc.Assembly.Group:
        kind = next(name for name in COLORS if name in obj.Name)
        items.append((obj.Name, obj.Shape, COLORS[kind]))
    write_glb(folder / "linkage.glb", items)
    App.closeDocument(doc.Name)


if __name__ == "__main__":
    generate(Path(sys.argv[1]), float(sys.argv[2]))
