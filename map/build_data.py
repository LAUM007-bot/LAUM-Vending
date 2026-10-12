"""Convert osm.xml (OpenStreetMap export) into compact local-metre JSON for the 3D map."""
import json, math, sys
import xml.etree.ElementTree as ET

LAT0, LON0 = 15.388446, 104.551576  # ตู้ที่ 1 (จากลิงก์ Google Maps)
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110540
R = 430  # crop radius in metres


def xz(lat, lon):
    return [round((lon - LON0) * KX, 1), round(-(lat - LAT0) * KZ, 1)]


root = ET.parse(sys.argv[1] if len(sys.argv) > 1 else "osm.xml").getroot()
nodes = {n.get("id"): (float(n.get("lat")), float(n.get("lon"))) for n in root.findall("node")}

ROAD_W = {"trunk": 14, "trunk_link": 8, "secondary": 11, "tertiary": 9, "unclassified": 7,
          "residential": 6, "service": 4, "path": 2, "footway": 2, "track": 3}

out = {"roads": [], "buildings": [], "areas": [], "pois": []}
for w in root.findall("way"):
    t = {x.get("k"): x.get("v") for x in w.findall("tag")}
    pts = [xz(*nodes[nd.get("ref")]) for nd in w.findall("nd") if nd.get("ref") in nodes]
    if len(pts) < 2:
        continue
    if not any(abs(p[0]) < R and abs(p[1]) < R for p in pts):
        continue
    if "highway" in t and t["highway"] in ROAD_W:
        # split into pieces that stay inside the crop square
        piece = []
        for p in pts:
            if abs(p[0]) < R + 40 and abs(p[1]) < R + 40:
                piece.append(p)
            else:
                if len(piece) > 1:
                    out["roads"].append({"k": t["highway"], "w": ROAD_W[t["highway"]], "n": t.get("name", ""), "p": piece})
                piece = []
        if len(piece) > 1:
            out["roads"].append({"k": t["highway"], "w": ROAD_W[t["highway"]], "n": t.get("name", ""), "p": piece})
    elif "building" in t:
        lv = t.get("building:levels")
        h = float(lv) * 3.2 if lv and lv.replace(".", "").isdigit() else (8 if t["building"] == "school" else 0)
        out["buildings"].append({"k": t["building"], "n": t.get("name", ""), "h": h, "p": pts[:-1] if pts[0] == pts[-1] else pts})
    else:
        kind = None
        if t.get("natural") == "water":
            kind = "water"
        elif t.get("leisure") in ("pitch", "track"):
            kind = "pitch"
        elif t.get("leisure") in ("garden", "park") or t.get("landuse") in ("grass", "recreation_ground"):
            kind = "park"
        elif t.get("amenity") == "parking":
            kind = "parking"
        elif t.get("amenity") in ("school", "marketplace", "place_of_worship") or t.get("landuse") == "religious":
            kind = "zone"
        if kind and pts[0] == pts[-1]:
            out["areas"].append({"k": kind, "n": t.get("name", ""), "p": pts[:-1]})

for n in root.findall("node"):
    t = {x.get("k"): x.get("v") for x in n.findall("tag")}
    if "name" in t and ("amenity" in t or "shop" in t):
        p = xz(float(n.get("lat")), float(n.get("lon")))
        if math.hypot(*p) < R:
            out["pois"].append({"n": t["name"], "k": t.get("amenity") or t.get("shop"), "p": p})

with open("map-data.js", "w", encoding="utf-8") as f:
    f.write("window.MAP_DATA = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
print({k: len(v) for k, v in out.items()})
# nearest roads to origin, to place the machine sensibly
def seg_d(p, a, b):
    ax, az = a; bx, bz = b; dx, dz = bx - ax, bz - az
    L = dx * dx + dz * dz or 1
    s = max(0, min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / L))
    return math.hypot(ax + s * dx - p[0], az + s * dz - p[1])
near = sorted((min(seg_d((0, 0), r["p"][i], r["p"][i + 1]) for i in range(len(r["p"]) - 1)), r["k"], r["n"]) for r in out["roads"])[:4]
print(near)
print("bbox", min(p[0] for r in out["roads"] for p in r["p"]), max(p[0] for r in out["roads"] for p in r["p"]))
