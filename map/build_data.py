"""Convert an OpenStreetMap export into compact local-metre JSON for the 3D map.

usage: python build_data.py osm3k.xml [radius_m]
  radius_m = half the width of the square map (default 1500 -> 3 x 3 km)
"""
import json, math, sys
import xml.etree.ElementTree as ET

LAT0, LON0 = 15.388446, 104.551576  # จุดที่ 1 (หน้าบ้าน) = กลางแผนที่
KX = 111320 * math.cos(math.radians(LAT0))
KZ = 110540
SRC = sys.argv[1] if len(sys.argv) > 1 else "osm.xml"
R = float(sys.argv[2]) if len(sys.argv) > 2 else 1500


def xz(lat, lon):
    return [round((lon - LON0) * KX, 1), round(-(lat - LAT0) * KZ, 1)]


root = ET.parse(SRC).getroot()
nodes = {n.get("id"): (float(n.get("lat")), float(n.get("lon"))) for n in root.findall("node")}

ROAD_W = {"trunk": 14, "trunk_link": 8, "secondary": 11, "tertiary": 9, "unclassified": 7,
          "residential": 6, "service": 4, "path": 2, "footway": 2, "track": 3}
RIVER_W = {"river": 38, "stream": 5, "canal": 8}

inside = lambda p, m=0: abs(p[0]) < R + m and abs(p[1]) < R + m


def pieces(pts, margin):
    """split a line into the parts that stay inside the map square"""
    out, cur = [], []
    for p in pts:
        if inside(p, margin):
            cur.append(p)
        else:
            if len(cur) > 1:
                out.append(cur)
            cur = []
    if len(cur) > 1:
        out.append(cur)
    return out


out = {"r": R, "roads": [], "rivers": [], "buildings": [], "areas": [], "pois": []}
for w in root.findall("way"):
    t = {x.get("k"): x.get("v") for x in w.findall("tag")}
    pts = [xz(*nodes[nd.get("ref")]) for nd in w.findall("nd") if nd.get("ref") in nodes]
    if len(pts) < 2 or not any(inside(p) for p in pts):
        continue
    if "highway" in t and t["highway"] in ROAD_W:
        for pc in pieces(pts, 40):
            out["roads"].append({"k": t["highway"], "w": ROAD_W[t["highway"]], "n": t.get("name", ""), "p": pc})
    elif t.get("waterway") in RIVER_W:
        for pc in pieces(pts, 60):
            out["rivers"].append({"k": t["waterway"], "w": RIVER_W[t["waterway"]], "n": t.get("name", ""), "p": pc})
    elif "building" in t:
        lv = t.get("building:levels")
        h = float(lv) * 3.2 if lv and lv.replace(".", "").isdigit() else (8 if t["building"] == "school" else 0)
        out["buildings"].append({"k": t["building"], "n": t.get("name", ""), "h": h, "p": pts[:-1] if pts[0] == pts[-1] else pts})
    else:
        kind = None
        if t.get("natural") == "water":
            kind = "water"
        elif t.get("natural") == "wood" or t.get("landuse") == "forest":
            kind = "wood"
        elif t.get("landuse") in ("farmland", "meadow"):
            kind = "farm"
        elif t.get("landuse") == "residential":
            kind = "village"
        elif t.get("leisure") in ("pitch", "track"):
            kind = "pitch"
        elif t.get("leisure") in ("garden", "park") or t.get("landuse") in ("grass", "recreation_ground"):
            kind = "park"
        elif t.get("amenity") == "parking":
            kind = "parking"
        elif t.get("amenity") in ("school", "marketplace", "place_of_worship", "hospital") or t.get("landuse") == "religious":
            kind = "zone"
        if kind and pts[0] == pts[-1]:
            out["areas"].append({"k": kind, "n": t.get("name", ""), "p": pts[:-1]})

for n in root.findall("node"):
    t = {x.get("k"): x.get("v") for x in n.findall("tag")}
    if "name" in t and ("amenity" in t or "shop" in t):
        p = xz(float(n.get("lat")), float(n.get("lon")))
        if inside(p):
            out["pois"].append({"n": t["name"], "k": t.get("amenity") or t.get("shop"), "p": p})

with open("map-data.js", "w", encoding="utf-8") as f:
    f.write("window.MAP_DATA = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
print({k: (len(v) if isinstance(v, list) else v) for k, v in out.items()})
