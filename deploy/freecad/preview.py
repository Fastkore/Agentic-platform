"""Export FreeCAD tessellations in millimetres to a self-contained Y-up glTF scene."""
import json
import struct


def write_glb(path, parts):
    data = bytearray()
    doc = {"asset":{"version":"2.0"}, "scene":0, "scenes":[{"nodes":[]}],
           "nodes":[], "meshes":[], "materials":[], "accessors":[], "bufferViews":[]}
    for index, (name, shape, color) in enumerate(parts):
        vertices, faces = shape.tessellate(.065)
        points = [(p.x/1000, p.z/1000, -p.y/1000) for p in vertices]
        pos = len(doc["accessors"])
        for values, layout, component, kind, count in (
                (points,"<3f",5126,"VEC3",len(points)), (faces,"<3I",5125,"SCALAR",len(faces)*3)):
            offset = len(data)
            for value in values:
                data.extend(struct.pack(layout, *value))
            view = len(doc["bufferViews"])
            doc["bufferViews"].append({"buffer":0,"byteOffset":offset,"byteLength":len(data)-offset})
            accessor = {"bufferView":view,"componentType":component,"type":kind,"count":count}
            if kind == "VEC3":
                accessor.update(min=list(map(min,zip(*points))), max=list(map(max,zip(*points))))
            doc["accessors"].append(accessor)
        doc["materials"].append({"pbrMetallicRoughness":{"baseColorFactor":[*color,1],
                                 "metallicFactor":.25,"roughnessFactor":.55}})
        doc["meshes"].append({"primitives":[{"attributes":{"POSITION":pos},"indices":pos+1,"material":index}]})
        doc["nodes"].append({"name":name,"mesh":index})
        doc["scenes"][0]["nodes"].append(index)
    doc["buffers"] = [{"byteLength":len(data)}]
    header = json.dumps(doc,separators=(",",":")).encode()
    header += b" "*(-len(header)%4)
    with path.open("wb") as out:
        out.write(struct.pack("<4sIII4s", b"glTF",2,28+len(header)+len(data),len(header),b"JSON"))
        out.write(header)
        out.write(struct.pack("<I4s",len(data),b"BIN\0"))
        out.write(data)
