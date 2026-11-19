"""Build a parts list from an explicitly selected native assembly tree."""
from collections import Counter


def product_tree(root):
    items = {}
    count = 0

    def visit(occurrence, ancestors):
        nonlocal count
        count += 1
        if count > 4096:
            raise ValueError("BOM exceeds 4096 occurrences")
        obj = occurrence.getLinkedObject(True) if occurrence.TypeId == "App::Link" else occurrence
        if obj.Name in ancestors:
            raise ValueError("Circular BOM at " + obj.Name)
        def value(prop):
            return str(getattr(occurrence,prop,getattr(obj,prop,"")))
        designation = value("PartNumber")
        key = designation or obj.Name
        group = obj.Group if obj.TypeId in ("App::DocumentObjectGroup","App::Part","App::LinkGroup") else []
        children = Counter(visit(c,ancestors | {obj.Name}) for c in group if c.TypeId != "App::Origin")
        item = {"designation":designation, "label":obj.Label, "category":value("BOMCategory"),
                "erpItemId":value("ErpItemId"), "children":dict(children)}
        prior = items.get(key)
        if prior is not None:
            if any(prior[p] != item[p] for p in ("category","erpItemId","children")):
                raise ValueError("Conflicting definitions for designation " + key)
        else:
            items[key] = item
        return key

    return {"root":visit(root,set()), "items":items}
