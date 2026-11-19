"""Headless FreeCAD commands. Runs only inside a fresh per-operation namespace."""
import json
import math
from pathlib import Path
import sys

import FreeCAD as App
import Part
import Sketcher

from preview import write_glb
from bom import product_tree

V = App.Vector
WORK = Path("/work")
SOURCE = WORK / "source.FCStd"
MODEL = WORK / "model.FCStd"


def hide_operands(doc):
    # FreeCAD headless does not always mirror the GUI's automatic hiding of CSG operands.
    # Explicit assembly members may also be displayed independently.
    members = {c.Name for g in doc.Objects if g.TypeId in ("App::DocumentObjectGroup","App::LinkGroup")
               for c in g.Group}
    for obj in doc.Objects:
        if obj.TypeId in ("Part::Cut","Part::Fuse","Part::Common"):
            operands = (obj.Base,obj.Tool)
        elif obj.TypeId in ("Part::MultiFuse","Part::MultiCommon"):
            operands = obj.Shapes
        elif obj.TypeId == "Part::Compound":
            operands = obj.Links
        else:
            continue
        for operand in operands:
            if operand and operand.Name not in members:
                operand.Visibility = False


def geometry(doc):
    """Return visible shape owners. A Body or Link already contains its children."""
    items = []
    for obj in doc.Objects:
        if not (obj.isDerivedFrom("Part::Feature") or obj.TypeId == "App::Link") or obj.Shape.isNull() or not obj.Visibility:
            continue
        parent = obj.getParentGeoFeatureGroup()
        while parent and parent.Visibility and not parent.isDerivedFrom("PartDesign::Body"):
            parent = parent.getParentGeoFeatureGroup()
        if parent or obj.isDerivedFrom("Sketcher::SketchObject") and obj.InList:
            continue
        shape = obj.Shape.copy()
        container = obj.getParentGeoFeatureGroup()
        if container is not None:
            shape.Placement = container.getGlobalPlacement().multiply(shape.Placement)
        items.append((obj, shape))
    return items


def identifiers(obj):
    record = {"freecadObject": obj.Name}
    for key in ("ErpItemId","ErpEntitySetId","ErpInstallationId","ErpEntityUri","ErpSpecificationId","PartNumber","BOMCategory"):
        if key in obj.PropertiesList:
            record[key] = str(getattr(obj,key))[:320]
    return record


def native_record(obj, shape):
    box = shape.optimalBoundingBox(False)
    record = {"name": obj.Name, "label": obj.Label, "type": obj.TypeId,
              "boundsMm": [round(v, 3) for v in (box.XMin,box.YMin,box.ZMin,box.XMax,box.YMax,box.ZMax)]}
    record.update(identifiers(obj))
    return record


def describe_feature(obj):
    item = {"name":obj.Name, "type":obj.TypeId, "label":obj.Label}
    if "Group" in obj.PropertiesList:
        item["children"] = [child.Name for child in obj.Group[:80]]
    values = {}
    for prop in obj.PropertiesList:
        if obj.getTypeIdOfProperty(prop) in ("App::PropertyLength","App::PropertyDistance","App::PropertyAngle"):
            values[prop] = round(getattr(obj,prop).Value,3)
    if values:
        item["dimensions"] = values
    return item


def save_summary(doc, items):
    summary = {"document": doc.Label, "objects": len(doc.Objects), "components": len(items),
               "parts": [native_record(o, s) for o, s in items[:80]],
               "tree": [describe_feature(o) for o in doc.Objects[:160]]}
    (WORK / "report.json").write_text(json.dumps(summary, ensure_ascii=False), encoding="utf8")


def bind_item(obj, item_id, part_number="", entity_set_id="", installation_id="", entity_uri=""):
    """Store a catalogue reference on this occurrence; the caller resolves the ID via ERP."""
    from uuid import UUID
    item_id = str(UUID(item_id))
    values = {"ErpItemId":item_id, "PartNumber":part_number}
    if entity_set_id:
        values["ErpEntitySetId"] = str(UUID(entity_set_id))
    if installation_id:
        values["ErpInstallationId"] = installation_id
    if entity_uri:
        values["ErpEntityUri"] = entity_uri
    for prop, value in values.items():
        if prop not in obj.PropertiesList:
            obj.addProperty("App::PropertyString", prop, "ERP")
        setattr(obj, prop, str(value))


def main(mode):
    if mode == "export":
        doc = App.openDocument(str(MODEL))
        doc.recompute()
        items = geometry(doc)
        if not items:
            raise ValueError("No visible geometry. Set Visibility on the final part objects.")
        if any("Invalid" in obj.State for obj in doc.Objects):
            raise ValueError("Document contains a failed feature after recompute")
        palette = [(0.36,0.58,0.72),(0.55,0.68,0.57),(0.71,0.56,0.35),(0.63,0.67,0.72)]
        parts = []
        for index, (obj, shape) in enumerate(items):
            if not shape.isValid() or not shape.Faces:
                raise ValueError("Invalid shape or no faces on " + obj.Name)
            parts.append((obj.Label, shape, palette[index % len(palette)]))
        write_glb(WORK / "model.glb", parts, [identifiers(o) for o, _ in items])
        save_summary(doc, items)
        if len(sys.argv) > 2:
            root = doc.getObject(sys.argv[2])
            if root is None:
                raise ValueError("Unknown BOM root: " + sys.argv[2])
            (WORK / "bom.json").write_text(json.dumps(product_tree(root),ensure_ascii=False,indent=2),encoding="utf8")
        return
    doc = App.openDocument(str(SOURCE)) if SOURCE.exists() else App.newDocument("Design")
    if mode == "inspect":
        doc.recompute()
        save_summary(doc, geometry(doc))
        return
    inputs = json.loads((WORK / "inputs.json").read_text())
    scope = {"App":App, "Part":Part, "Sketcher":Sketcher, "math":math, "V":V,
             "doc":doc, "input_files":inputs, "bind_item":bind_item}
    exec(compile((WORK / "design.py").read_text(encoding="utf8"), "design.py", "exec"), scope)
    doc.recompute()
    hide_operands(doc)
    doc.saveAs(str(MODEL))


if __name__ == "__main__":
    main(sys.argv[1])
