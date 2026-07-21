#!/usr/bin/env python3
"""Simplify timezone-boundary-builder GeoJSON for point-in-polygon use.

Produces natural_earth/timezones.geojson, which timezone_service.go loads to add
the "timezone" field to /api/maidenhead/country results.

Source data (land only — ocean clicks are reported without a timezone):

    https://github.com/evansiroky/timezone-boundary-builder/releases
    asset: timezones.geojson.zip   (ODbL, derived from OpenStreetMap)

The raw release is ~170 MB with 7.6M vertices, far too large to ship.  This
script applies Douglas-Peucker per ring and rounds coordinates, which for the
tolerance used below keeps 419 zones in ~10 MB.  Sampling 1500 random land
points against the unsimplified source gave identical answers for every point;
the residual error is at boundaries, bounded by roughly the tolerance
(0.002° ≈ 200 m).

Rings are never dropped, so small islands survive: a ring that collapses below a
triangle keeps its extreme points instead of disappearing.

Regenerate after a new upstream release (a few per year, as governments change
rules):

    curl -LO https://github.com/evansiroky/timezone-boundary-builder/releases/download/<tag>/timezones.geojson.zip
    unzip timezones.geojson.zip                      # -> combined.json
    python3 tools/simplify_timezones.py combined.json natural_earth/timezones.geojson 0.002 4

Douglas-Peucker per ring, then coordinate rounding.
"""
import json
import sys


def dp(points, tol):
    """Iterative Douglas-Peucker. points is a list of [x, y]."""
    n = len(points)
    if n < 3:
        return points[:]
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        maxd, idx = -1.0, -1
        for i in range(first + 1, last):
            px, py = points[i]
            if denom == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                # squared perpendicular distance to the segment's line
                cross = dx * (py - ay) - dy * (px - ax)
                d = cross * cross / denom
            if d > maxd:
                maxd, idx = d, i
        if maxd > tol * tol:
            keep[idx] = True
            stack.append((first, idx))
            stack.append((idx, last))
    return [points[i] for i in range(n) if keep[i]]


def simplify_ring(ring, tol, ndigits):
    out = dp(ring, tol)
    # A ring that collapsed below a triangle keeps its extreme points so tiny
    # islands do not silently disappear
    if len(out) < 4:
        xs = sorted(ring, key=lambda p: p[0])
        ys = sorted(ring, key=lambda p: p[1])
        out = [xs[0], ys[0], xs[-1], ys[-1]]
    out = [[round(x, ndigits), round(y, ndigits)] for x, y in out]
    # drop consecutive duplicates created by rounding
    ded = [out[0]]
    for p in out[1:]:
        if p != ded[-1]:
            ded.append(p)
    if ded[0] != ded[-1]:
        ded.append(ded[0])
    return ded if len(ded) >= 4 else None


def count(geom):
    c = geom["coordinates"]
    if geom["type"] == "Polygon":
        return sum(len(r) for r in c)
    return sum(len(r) for p in c for r in p)


def main():
    src, dst, tol, ndigits = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4])
    data = json.load(open(src))

    before = after = 0
    feats = []
    for f in data["features"]:
        g = f["geometry"]
        before += count(g)
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        new_polys = []
        for poly in polys:
            rings = [r for r in (simplify_ring(ring, tol, ndigits) for ring in poly) if r]
            if rings:
                new_polys.append(rings)
        if not new_polys:
            continue
        geom = ({"type": "Polygon", "coordinates": new_polys[0]} if len(new_polys) == 1
                else {"type": "MultiPolygon", "coordinates": new_polys})
        after += count(geom)
        feats.append({"type": "Feature",
                      "properties": {"tzid": f["properties"]["tzid"]},
                      "geometry": geom})

    out = {"type": "FeatureCollection", "features": feats}
    text = json.dumps(out, separators=(",", ":"))
    open(dst, "w").write(text)
    print(f"tol {tol:<7} round {ndigits}  zones {len(feats):3d}  "
          f"vertices {before:,} -> {after:,} ({100*after/before:.1f}%)  "
          f"{len(text)/1e6:.1f} MB")


if __name__ == "__main__":
    main()
