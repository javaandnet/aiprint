#!/usr/bin/env python3
"""Parametric filter box for the Bambu Lab P2S external exhaust fan kit.

Target mounting: Plan 2 ("reuse the original printer rear panel"), where a
printed adapter is screwed to the stock rear panel with 3x M3x6 and the fan
assembly clips into that adapter. This box replaces the "stick the filter pad
onto the fan with foam corners" step: the pad becomes a serviceable cartridge
inside a sealed plenum, and the box itself is fixed with two M3 screws.

Air path (passive, no fan): rear panel vent -> rear opening -> plenum ->
filter pad -> room. Set --port-d > 0 to switch the rear opening back to a
round fan-nozzle port with a foam seat ring (external exhaust fan kit).

Units: millimetres. The stock filter pad is assumed to be 105 x 135 x 20 mm
(user input "10.5 * 13.5 * 2" read as centimetres). Every dimension is a CLI
flag, so re-measure and regenerate instead of editing geometry.

Outputs (default ./out):
  p2s_filter_box_body.stl   tray + plenum + mount, print rear face down
  p2s_filter_box_lid.stl    retaining frame, print flat plate down
  p2s_filter_box_params.json  parameter snapshot for traceability

Requires: trimesh, manifold3d (boolean engine), shapely, numpy.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass

import numpy as np
import trimesh
from shapely.geometry import Point, Polygon, box as shp_box

ARC = 48  # segments per quadrant for rounded rectangles / circles


# --------------------------------------------------------------------------
# parameters
# --------------------------------------------------------------------------
@dataclass
class Params:
    # filter cartridge (mm)
    filter_w: float = 135.0  # X, long side
    filter_h: float = 105.0  # Y, short side
    filter_t: float = 20.0  # Z, media thickness
    clearance: float = 0.9  # per-side gap around the pad

    # shell
    wall: float = 2.4
    rear_t: float = 4.0  # plenum rear wall thickness
    front_clear: float = 7.0  # free space in front of the pad
    corner_r: float = 8.0

    # rear interface. Default = passive: a big rectangular opening over the
    # machine's rear vent, sealed to the panel with a foam groove.
    # port_d > 0 switches to a round fan-nozzle port (exhaust fan kit).
    rear_open_w: float = 116.0
    rear_open_h: float = 86.0
    rear_seal: bool = True  # foam groove on the rear flange face
    rear_seal_w: float = 3.0
    rear_seal_h: float = 1.2
    port_d: float = 0.0  # >0: fan nozzle OD telescoping into a round port
    seal_ring_w: float = 5.0  # fan mode: foam seat groove width
    seal_ring_h: float = 1.2  # fan mode: groove depth

    # mounting: "rear" = 2 holes through the plenum rear wall (default),
    #           "ears" = 2 chamfered side tabs with slots.
    # Both keep the rear face perfectly planar so the part prints flat with
    # zero supports. mount_z is the real gap to the machine surface: it only
    # drives the recommended screw length (bridge it with M3 washers/spacers).
    mount: str = "rear"
    screw_span: float = 124.0  # hole centre distance, X (rear mode)
    screw_y: float = 0.0  # hole centre height offset, Y (both modes)
    screw_d: float = 3.4  # M3 clearance
    screw_slot: float = 0.0  # >0 turns rear holes into X slots of this length
    cb_d: float = 6.4  # screw head counterbore, inner face
    cb_depth: float = 2.8
    mount_z: float = 0.0  # rear face -> machine surface gap (screw length hint)
    ear_w: float = 18.0  # ears mode: tab length beyond the outer wall
    ear_h: float = 26.0  # ears mode: tab height (Y)
    ear_slot: float = 8.0  # ears mode: slot length along Y

    # foam seal channel around the pad perimeter (4 open-ended grooves)
    foam_groove: bool = True
    groove_depth: float = 1.2
    groove_h: float = 4.0

    # lid
    lid_t: float = 3.0
    skirt_t: float = 2.0
    lid_fit: float = 0.5  # skirt-to-cavity clearance per side
    edge_cover: float = 3.5  # how much of the pad edge the frame covers
    clips: bool = False  # opt-in snap hooks on both X sides
    notch: float = 10.0  # finger notch depth on the +Y lid edge

    @property
    def cav_w(self) -> float:
        return self.filter_w + 2 * self.clearance

    @property
    def cav_h(self) -> float:
        return self.filter_h + 2 * self.clearance

    @property
    def W(self) -> float:
        return self.cav_w + 2 * self.wall

    @property
    def H(self) -> float:
        return self.cav_h + 2 * self.wall

    @property
    def D(self) -> float:
        return self.rear_t + self.filter_t + self.front_clear

    @property
    def port_hole_d(self) -> float:
        return self.port_d + 3.0

    @property
    def skirt_d(self) -> float:
        return self.front_clear - 1.0

    @property
    def window_w(self) -> float:
        return self.filter_w - 2 * self.edge_cover

    @property
    def window_h(self) -> float:
        return self.filter_h - 2 * self.edge_cover


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------
def rrect(w: float, h: float, r: float, cx: float = 0.0, cy: float = 0.0):
    """Rounded rectangle as a shapely polygon."""
    r = max(0.0, min(r, w / 2 - 1e-6, h / 2 - 1e-6))
    if r < 0.05:
        return shp_box(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    core = shp_box(cx - w / 2 + r, cy - h / 2 + r, cx + w / 2 - r, cy + h / 2 - r)
    return core.buffer(r, resolution=ARC)


def disc(d: float, cx: float = 0.0, cy: float = 0.0):
    return Point(cx, cy).buffer(d / 2.0, resolution=ARC)


def prism(poly, z0: float, z1: float) -> trimesh.Trimesh:
    m = trimesh.creation.extrude_polygon(poly, height=z1 - z0)
    m.apply_translation([0.0, 0.0, z0])
    return m


def slot_poly(cx: float, cy: float, length: float, width: float, along_x: bool = True):
    """Rounded slot (stadium shape). length includes the round ends."""
    half = max(length / 2.0 - width / 2.0, 0.0)
    if along_x:
        core = shp_box(cx - half, cy - width / 2, cx + half, cy + width / 2)
    else:
        core = shp_box(cx - width / 2, cy - half, cx + width / 2, cy + half)
    return core.buffer(width / 2.0, resolution=ARC // 2)


def merge(meshes) -> trimesh.Trimesh:
    out = None
    for m in meshes:
        out = m if out is None else out.union(m)
    return out


def cut(a: trimesh.Trimesh, *voids) -> trimesh.Trimesh:
    for v in voids:
        a = a.difference(v)
    return a


def report(tag: str, m: trimesh.Trimesh) -> None:
    print(f"[mesh] {tag}: faces={len(m.faces)} watertight={m.is_watertight} "
          f"volume={m.volume / 1000.0:.1f} cm3 bbox={np.round(m.extents, 2).tolist()}")


# --------------------------------------------------------------------------
# body
# --------------------------------------------------------------------------
def build_body(p: Params) -> trimesh.Trimesh:
    W, H, D, Zr = p.W, p.H, p.D, p.rear_t
    cav = rrect(p.cav_w, p.cav_h, p.corner_r)

    body = prism(rrect(W, H, p.corner_r), 0.0, D)
    body = cut(body, prism(cav, Zr, D + 1.0))  # open-front plenum cup

    # --- rear opening + recessed seal groove (never proud: keeps the
    # mounting plane flat so the part prints with zero supports) ---
    if p.port_d > 0.01:
        hd = p.port_hole_d
        body = cut(body, prism(disc(hd), -1.0, Zr + 1.0))
        groove = disc(hd + 4.0 + 2 * p.seal_ring_w).difference(disc(hd + 4.0))
        body = cut(body, prism(groove, -1.0, p.seal_ring_h))
    else:
        body = cut(body, prism(rrect(p.rear_open_w, p.rear_open_h, 6.0),
                               -1.0, Zr + 1.0))
        if p.rear_seal:
            # perimeter foam groove on the rear flange face; the left/right
            # runs stop short of y=0 so they never meet the screw bores
            sw, sh = p.rear_seal_w, p.rear_seal_h
            ox, oy = W / 2 - 2.0, H / 2 - 4.0
            ix, iy = ox - sw, oy - sw
            segs = [
                shp_box(-ox, iy, ox, oy),          # top
                shp_box(-ox, -oy, ox, -iy),        # bottom
                shp_box(ix, 20.0, ox, oy),         # right upper
                shp_box(ix, -oy, ox, -20.0),       # right lower
                shp_box(-ox, iy, -ix, oy),         # left upper
                shp_box(-ox, -oy, -ix, -20.0),     # left lower
            ]
            body = cut(body, *[prism(s, -1.0, sh) for s in segs])

    # --- mounting ---
    if p.mount == "rear":
        for sx in (-1.0, 1.0):
            cx = sx * p.screw_span / 2.0
            hole = (slot_poly(cx, p.screw_y, p.screw_d + p.screw_slot, p.screw_d, True)
                    if p.screw_slot > 0.01 else disc(p.screw_d, cx, p.screw_y))
            body = cut(body, prism(hole, -1.0, Zr + 1.0))
            body = cut(body, prism(disc(p.cb_d, cx, p.screw_y),
                                   Zr - p.cb_depth, Zr + 1.0))
    elif p.mount == "ears":
        ear_t = p.rear_t + 2.0
        for sx in (-1.0, 1.0):
            x0 = sx * (W / 2 - 2.0)
            x1 = sx * (W / 2 + p.ear_w)
            tab = shp_box(min(x0, x1), -p.ear_h / 2, max(x0, x1), p.ear_h / 2)
            # 45 deg lead-in chamfers on the two outer corners (XY plane)
            c = 6.0
            xo = max(x0, x1) if sx > 0 else min(x0, x1)
            for sy in (-1.0, 1.0):
                yo = sy * p.ear_h / 2
                tab = tab.difference(Polygon([(xo, yo), (xo - sx * c, yo),
                                              (xo, yo - sy * c)]))
            body = merge([body, prism(tab, 0.0, ear_t)])
            cx = sx * (W / 2 + p.ear_w / 2)
            body = cut(body, prism(slot_poly(cx, p.screw_y, p.ear_slot, p.screw_d, False),
                                   -1.0, ear_t + 1.0))
    else:
        raise SystemExit(f"[error] unknown mount mode: {p.mount}")

    # --- foam seal channels: 4 independent grooves, open at both ends ---
    if p.foam_groove:
        mid = Zr + p.filter_t / 2.0
        z0, z1 = mid - p.groove_h / 2, mid + p.groove_h / 2
        gx = p.cav_w / 2 - p.groove_depth
        gy = p.cav_h / 2 - p.groove_depth
        ext = p.wall  # keep >=1 mm of outer skin behind the foam channel
        span_x = p.cav_w / 2 - p.corner_r - 0.5  # stop before the corner arcs
        span_y = p.cav_h / 2 - p.corner_r - 0.5
        grooves = [
            shp_box(-span_x, gy, span_x, gy + ext),
            shp_box(-span_x, -gy - ext, span_x, -gy),
            shp_box(gx, -span_y, gx + ext, span_y),
            shp_box(-gx - ext, -span_y, -gx, span_y),
        ]
        body = cut(body, *[prism(g, z0, z1) for g in grooves])

    # --- snap catch recesses (only when the lid carries hooks) ---
    # Recess sits 11-13 mm below the rim so the lid hook gets a ~16 mm
    # cantilever: 1.6 mm assembly deflection keeps PETG strain near 2.4%.
    if p.clips:
        for sx in (-1.0, 1.0):
            x0 = sx * (W / 2 - 2.0)
            x1 = sx * (W / 2 + 2.0)
            body = cut(body, prism(shp_box(min(x0, x1), -11.0, max(x0, x1), 11.0),
                                   D - 13.0, D - 11.0))
    return body


# --------------------------------------------------------------------------
# lid (built in assembly coordinates, flipped to print orientation on export)
# --------------------------------------------------------------------------
def build_lid(p: Params) -> trimesh.Trimesh:
    W, H, D = p.W, p.H, p.D
    plate = prism(rrect(W, H, p.corner_r), D, D + p.lid_t)
    window = rrect(p.window_w, p.window_h, max(p.corner_r - p.edge_cover, 1.0))
    lid = cut(plate, prism(window, D - 1.0, D + p.lid_t + 1.0))

    skirt_out = rrect(p.cav_w - p.lid_fit, p.cav_h - p.lid_fit,
                      max(p.corner_r - p.lid_fit / 2, 1.0))
    skirt_in = rrect(p.cav_w - p.lid_fit - 2 * p.skirt_t,
                     p.cav_h - p.lid_fit - 2 * p.skirt_t,
                     max(p.corner_r - p.lid_fit / 2 - p.skirt_t, 0.5))
    lid = merge([lid, prism(skirt_out.difference(skirt_in), D - p.skirt_d, D)])

    # finger notch on the +Y edge
    if p.notch > 0.01:
        lid = cut(lid, prism(shp_box(-14.0, H / 2 - p.notch, 14.0, H / 2 + 2.0),
                             D - 1.0, D + p.lid_t + 1.0))

    # snap hooks: long arm outside the wall + lip landing in the body recess
    if p.clips:
        arm_w, arm_h, gap = 2.6, 16.0, 0.6
        for sx in (-1.0, 1.0):
            xi = sx * (W / 2 + gap)
            xo = sx * (W / 2 + gap + arm_w)
            arm = shp_box(min(xi, xo), -arm_h / 2, max(xi, xo), arm_h / 2)
            lid = merge([lid, prism(arm, D - 13.0, D + p.lid_t)])
            # root bridge: the arm lives outside the plate footprint, so tie
            # it back into the plate or it prints as a loose floating shell
            root = shp_box(min(sx * (W / 2 - 3.0), xo), -arm_h / 2,
                           max(sx * (W / 2 - 3.0), xo), arm_h / 2)
            lid = merge([lid, prism(root, D, D + p.lid_t)])
            lip_x0 = sx * (W / 2 + gap)
            lip_x1 = sx * (W / 2 - 1.4)
            lip = shp_box(min(lip_x0, lip_x1), -arm_h / 2 + 1.0,
                          max(lip_x0, lip_x1), arm_h / 2 - 1.0)
            lid = merge([lid, prism(lip, D - 13.0, D - 11.0)])
    return lid


def to_print_orientation(m: trimesh.Trimesh, flip_x: bool = False) -> trimesh.Trimesh:
    out = m.copy()
    if flip_x:
        out.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
    out.apply_translation(-out.bounds[0])
    return out


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def parse_args(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    ap.add_argument("--mount", choices=["rear", "ears"], default=None)
    ap.add_argument("--clips", action="store_true", default=None)
    ap.add_argument("--no-foam-groove", action="store_true")
    ap.add_argument("--no-drawing", action="store_true")
    for f in Params.__dataclass_fields__.values():
        if f.name in ("mount", "clips", "foam_groove"):
            continue
        ap.add_argument("--" + f.name.replace("_", "-"), type=float, default=None)
    a = ap.parse_args(argv)
    p = Params()
    for f in Params.__dataclass_fields__:
        v = getattr(a, f, None)
        if v is not None:
            setattr(p, f, v)
    if a.mount:
        p.mount = a.mount
    if a.clips:
        p.clips = True
    if a.no_foam_groove:
        p.foam_groove = False
    if p.screw_slot < 0:
        raise SystemExit("[error] --screw-slot must be >= 0")
    return p, a


def main(argv=None) -> int:
    p, a = parse_args(argv)
    os.makedirs(a.out, exist_ok=True)

    body = build_body(p)
    lid = build_lid(p)
    report("body", body)
    report("lid", lid)

    # assembly interference check: lid must seat without touching the tray
    with np.errstate(divide="ignore", invalid="ignore"):
        inter = body.intersection(lid).volume
    print(f"[check] lid/body interference = {inter:.3f} mm3 (expect ~0)")
    if inter > 1.0:
        print("[error] lid interferes with body, adjust lid_fit/skirt", file=sys.stderr)
        return 1
    for tag, m in (("body", body), ("lid", lid)):
        shells = len(m.split(only_watertight=False))
        print(f"[check] {tag} shells = {shells} (expect 1)")
        if shells != 1:
            print(f"[error] {tag} has disconnected shells", file=sys.stderr)
            return 1

    body_print = to_print_orientation(body)
    lid_print = to_print_orientation(lid, flip_x=True)
    for name, m in (("body", body_print), ("lid", lid_print)):
        path = os.path.join(a.out, f"p2s_filter_box_{name}.stl")
        m.export(path)
        print(f"[stl] wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)")

    snap = asdict(p)
    snap.update({"outer_w": round(p.W, 2), "outer_h": round(p.H, 2),
                 "depth": round(p.D, 2), "port_hole_d": round(p.port_hole_d, 2)})
    with open(os.path.join(a.out, "p2s_filter_box_params.json"), "w") as fh:
        json.dump(snap, fh, indent=2)

    mass = (body.volume + lid.volume) / 1000.0 * 1.27 * 0.85  # PETG, ~15% infill
    thick = p.rear_t if p.mount == "rear" else p.rear_t + 2.0
    screw_len = thick + p.mount_z + 6.0  # 6 mm thread engagement
    span_txt = (f"hole span {p.screw_span:.1f} mm" if p.mount == "rear"
                else f"ear hole span {p.W + p.ear_w:.1f} mm")
    print(f"[summary] outer {p.W:.1f} x {p.H:.1f} x {p.D + p.lid_t:.1f} mm, "
          f"filter {p.filter_w:.0f} x {p.filter_h:.0f} x {p.filter_t:.0f} mm, "
          f"mount={p.mount}, est. PETG mass {mass:.0f} g")
    print(f"[summary] screws: 2x M3 x {screw_len:.0f} mm "
          f"(mount_z={p.mount_z:.1f}), {span_txt}")
    if p.port_d > 0.01:
        print(f"[summary] fan port hole dia {p.port_hole_d:.1f} mm")
    else:
        print(f"[summary] passive rear opening {p.rear_open_w:.0f} x "
              f"{p.rear_open_h:.0f} mm "
              f"({p.rear_open_w * p.rear_open_h / 100:.1f} cm2), "
              f"rear seal groove {'on' if p.rear_seal else 'off'}")
    print(f"[summary] lid window {p.window_w:.1f} x {p.window_h:.1f} mm "
          f"(open area {p.window_w * p.window_h / 100:.1f} cm2)")
    if not body.is_watertight or not lid.is_watertight:
        print("[error] non-watertight result, do not slice", file=sys.stderr)
        return 1

    if not a.no_drawing:
        try:
            from drawing import write_sheet
            write_sheet(p, body, lid, a.out)
        except Exception as exc:  # drawing is optional, STL is the deliverable
            print(f"[warn] drawing skipped: {type(exc).__name__}: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())