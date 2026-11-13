#!/usr/bin/env python3
"""Dimension sheet + isometric preview for the P2S filter box.

Called by filter_box.py; can also run standalone against the exported STLs:
    python3 drawing.py --out out
"""

from __future__ import annotations

import argparse
import json
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import trimesh
from matplotlib.patches import Circle, FancyArrowPatch, Rectangle
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

from filter_box import Params

INK = "#1f2933"
ACC = "#0b6bcb"
GHOST = "#c2410c"


def dim(ax, a, b, text, off=(0, 0), color=ACC, fs=8):
    """Simple two-arrow dimension line with a centred label."""
    ax.add_patch(FancyArrowPatch(a, b, arrowstyle="<|-|>", mutation_scale=7,
                                 color=color, lw=0.8, shrinkA=0, shrinkB=0))
    mid = ((a[0] + b[0]) / 2 + off[0], (a[1] + b[1]) / 2 + off[1])
    ax.text(mid[0], mid[1], text, color=color, fontsize=fs, ha="center",
            va="center", bbox=dict(fc="white", ec="none", pad=0.6))


def front_view(ax, p):
    W, H = p.W, p.H
    ax.add_patch(Rectangle((-W / 2, -H / 2), W, H, fill=False, ec=INK, lw=1.4))
    ax.add_patch(Rectangle((-p.cav_w / 2, -p.cav_h / 2), p.cav_w, p.cav_h,
                           fill=False, ec=INK, lw=0.7, ls=(0, (4, 2))))
    ax.add_patch(Rectangle((-p.filter_w / 2, -p.filter_h / 2), p.filter_w, p.filter_h,
                           fill=False, ec=GHOST, lw=1.0, ls=(0, (2, 2))))
    ax.add_patch(Rectangle((-p.window_w / 2, -p.window_h / 2), p.window_w, p.window_h,
                           fill=False, ec=ACC, lw=1.0))
    if p.port_d > 0.01:
        ax.add_patch(Circle((0, 0), p.port_hole_d / 2, fill=False, ec=INK, lw=1.0,
                            ls=(0, (4, 2))))
        ax.add_patch(Circle((0, 0), (p.port_hole_d + 4 + 2 * p.seal_ring_w) / 2,
                            fill=False, ec=INK, lw=0.6, ls=(0, (1, 2))))
    else:
        ax.add_patch(Rectangle((-p.rear_open_w / 2, -p.rear_open_h / 2),
                               p.rear_open_w, p.rear_open_h, fill=False,
                               ec=INK, lw=1.0, ls=(0, (4, 2))))
        if p.rear_seal:
            ox, oy = p.W / 2 - 2.0, p.H / 2 - 4.0
            ax.add_patch(Rectangle((-ox, -oy), 2 * ox, 2 * oy, fill=False,
                                   ec=INK, lw=0.6, ls=(0, (1, 2))))
    if p.mount == "rear":
        for sx in (-1, 1):
            cx = sx * p.screw_span / 2
            ax.add_patch(Circle((cx, p.screw_y), p.screw_d / 2, fill=False,
                                ec=ACC, lw=1.2))
            ax.plot([cx], [p.screw_y], "+", color=ACC, ms=5)
        dim(ax, (-p.screw_span / 2, -H / 2 - 12), (p.screw_span / 2, -H / 2 - 12),
            f"screw span {p.screw_span:.0f}", off=(0, -5))
    else:
        for sx in (-1, 1):
            x0, x1 = sx * (W / 2 - 2), sx * (W / 2 + p.ear_w)
            ax.add_patch(Rectangle((min(x0, x1), -p.ear_h / 2), abs(x1 - x0), p.ear_h,
                                   fill=False, ec=INK, lw=1.2))
            cx = sx * (W / 2 + p.ear_w / 2)
            ax.add_patch(Rectangle((cx - p.screw_d / 2, p.screw_y - p.ear_slot / 2),
                                   p.screw_d, p.ear_slot, fill=False, ec=ACC, lw=1.2))
        dim(ax, (-(W / 2 + p.ear_w), -H / 2 - 12), (W / 2 + p.ear_w, -H / 2 - 12),
            f"overall {W + 2 * p.ear_w:.0f}", off=(0, -5))
    dim(ax, (-W / 2, H / 2 + 10), (W / 2, H / 2 + 10), f"W {W:.1f}", off=(0, 5))
    hx = W / 2 + (p.ear_w + 4 if p.mount == "ears" else 0) + 10
    dim(ax, (hx, -H / 2), (hx, H / 2), f"H {H:.1f}", off=(11, 0))
    ax.text(0, p.window_h / 2 + 6, f"lid window {p.window_w:.0f} x {p.window_h:.0f}",
            ha="center", fontsize=7.5, color=ACC)
    if p.port_d > 0.01:
        ax.text(0, -p.port_hole_d / 2 - 7, f"port hole dia {p.port_hole_d:.0f} "
                f"(nozzle OD {p.port_d:.0f} + 3)", ha="center", fontsize=7.5,
                color=INK)
    else:
        ax.text(0, p.rear_open_h / 2 - 6,
                f"rear opening {p.rear_open_w:.0f} x {p.rear_open_h:.0f} "
                f"(passive, over rear vent)", ha="center", fontsize=7.5,
                color=INK)
    ax.text(-p.filter_w / 2 + 3, -p.filter_h / 2 + 5,
            f"filter {p.filter_w:.0f} x {p.filter_h:.0f} x {p.filter_t:.0f}",
            fontsize=7.5, color=GHOST)
    ax.set_title("Front view (looking at the room side)", fontsize=10, color=INK)
    ax.set_xlim(-W / 2 - 34, W / 2 + (p.ear_w + 30 if p.mount == "ears" else 34))
    ax.set_ylim(-H / 2 - 30, H / 2 + 26)


def section_view(ax, body, lid, p):
    segs = trimesh.intersections.mesh_plane(body, [0, 1, 0], [0, 0, 0])
    for s in segs:
        ax.plot(s[:, 0], s[:, 2], color=INK, lw=1.0, solid_capstyle="round")
    lsegs = trimesh.intersections.mesh_plane(lid, [0, 1, 0], [0, 0, 0])
    for s in lsegs:
        ax.plot(s[:, 0], s[:, 2], color=ACC, lw=1.0)
    Zr, D = p.rear_t, p.D
    ax.add_patch(Rectangle((-p.filter_w / 2, Zr), p.filter_w, p.filter_t,
                           fill=True, fc=GHOST, alpha=0.16, ec=GHOST, lw=1.0,
                           ls=(0, (3, 2))))
    ax.text(0, Zr + p.filter_t / 2, "filter pad", ha="center", va="center",
            fontsize=8, color=GHOST)
    dim(ax, (-p.W / 2 - 12, 0), (-p.W / 2 - 12, D + p.lid_t),
        f"total {D + p.lid_t:.1f}", off=(-13, 0))
    dim(ax, (p.W / 2 + 12, 0), (p.W / 2 + 12, Zr), f"rear {Zr:.1f}", off=(13, 0))
    dim(ax, (p.W / 2 + 12, Zr), (p.W / 2 + 12, Zr + p.filter_t),
        f"pad {p.filter_t:.0f}", off=(13, 0))
    dim(ax, (p.W / 2 + 12, Zr + p.filter_t), (p.W / 2 + 12, D),
        f"clear {p.front_clear:.0f}", off=(15, 0))
    ax.annotate("", xy=(0, -6), xytext=(0, -1),
                arrowprops=dict(arrowstyle="-|>", color=ACC, lw=1.0))
    ax.text(0, -9, "air in (fan nozzle)" if p.port_d > 0.01 else
            "air in (rear vent)", ha="center", fontsize=7.5, color=ACC)
    ax.annotate("", xy=(0, D + p.lid_t + 8), xytext=(0, D + p.lid_t + 2),
                arrowprops=dict(arrowstyle="-|>", color=GHOST, lw=1.0))
    ax.text(0, D + p.lid_t + 11, "air out (through pad)", ha="center",
            fontsize=7.5, color=GHOST)
    ax.annotate("foam channel", xy=(-p.W / 2 + 1.2, p.rear_t + p.filter_t / 2),
                xytext=(-p.W / 2 + 16, D + 9), fontsize=7, color=INK,
                arrowprops=dict(arrowstyle="-", color=INK, lw=0.6))
    ax.set_title("Section at Y=0 (machine side left, room side right)",
                 fontsize=10, color=INK)
    ax.set_xlim(-p.W / 2 - 34, p.W / 2 + 40)
    ax.set_ylim(-16, D + p.lid_t + 20)


def iso_view(ax, body, lid, p):
    def add(mesh, color, alpha=1.0, step=2):
        f = mesh.faces[::step]
        tris = mesh.vertices[f]
        n = mesh.face_normals[::step]
        light = np.clip(0.45 + 0.55 * (n @ np.array([0.4, -0.5, 0.75])), 0.25, 1.0)
        cols = np.array(matplotlib.colors.to_rgb(color))[None, :] * light[:, None]
        pc = Poly3DCollection(tris, facecolors=cols, edgecolors="none", alpha=alpha)
        ax.add_collection3d(pc)

    add(body, "#9aa5b1")
    add(lid, "#7fb2e5", alpha=0.55, step=3)
    fw, fh, ft = p.filter_w, p.filter_h, p.filter_t
    z0 = p.rear_t
    verts = np.array([[x, y, z] for x in (-fw / 2, fw / 2)
                      for y in (-fh / 2, fh / 2) for z in (z0, z0 + ft)])
    for i, j in ((0, 1), (0, 2), (1, 3), (2, 3), (4, 5), (4, 6), (5, 7), (6, 7),
                 (0, 4), (1, 5), (2, 6), (3, 7)):
        ax.plot(*zip(verts[i], verts[j]), color=GHOST, lw=0.7, ls=(0, (3, 2)))
    allm = trimesh.util.concatenate([body, lid])
    b = allm.bounds
    c = (b[0] + b[1]) / 2
    r = float(np.max(b[1] - b[0])) / 2 * 1.05
    ax.set_xlim(c[0] - r, c[0] + r)
    ax.set_ylim(c[1] - r, c[1] + r)
    ax.set_zlim(c[2] - r, c[2] + r)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev=22, azim=-58)
    ax.set_axis_off()
    ax.set_title("Isometric (lid shown in place, filter ghosted)", fontsize=10,
                 color=INK)


def write_sheet(p, body, lid, outdir):
    fig = plt.figure(figsize=(15.5, 5.9), dpi=140)
    gs = fig.add_gridspec(1, 3, width_ratios=[1.05, 1.0, 1.0], wspace=0.12)
    a1 = fig.add_subplot(gs[0, 0])
    a2 = fig.add_subplot(gs[0, 1])
    a3 = fig.add_subplot(gs[0, 2], projection="3d")
    for ax in (a1, a2):
        ax.set_aspect("equal")
        ax.axis("off")
    front_view(a1, p)
    section_view(a2, body, lid, p)
    iso_view(a3, body, lid, p)
    fig.suptitle(
        "Bambu Lab P2S external exhaust filter box - Plan 2 (stock rear panel + adapter)\n"
        f"filter {p.filter_w:.0f} x {p.filter_h:.0f} x {p.filter_t:.0f} mm | "
        f"outer {p.W:.1f} x {p.H:.1f} x {p.D + p.lid_t:.1f} mm | "
        f"mount: {p.mount} | "
        f"{'fan port dia ' + format(p.port_hole_d, '.0f') if p.port_d > 0.01 else 'passive, no fan'} | "
        f"material: PETG/ABS/PC | 0.2 mm layer, 3 perimeters, "
        f"15-20% infill, no supports",
        fontsize=10.5, color=INK, y=0.99)
    fig.subplots_adjust(top=0.86, bottom=0.02, left=0.02, right=0.98)
    svg = os.path.join(outdir, "p2s_filter_box_drawing.svg")
    png = os.path.join(outdir, "p2s_filter_box_drawing.png")
    fig.savefig(svg)
    fig.savefig(png)
    plt.close(fig)
    print(f"[drawing] wrote {svg}")
    print(f"[drawing] wrote {png}")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(here, "out"))
    a = ap.parse_args()
    with open(os.path.join(a.out, "p2s_filter_box_params.json")) as fh:
        snap = json.load(fh)
    p = Params(**{k: v for k, v in snap.items() if k in Params.__dataclass_fields__})
    body = trimesh.load(os.path.join(a.out, "p2s_filter_box_body.stl"))
    lid = trimesh.load(os.path.join(a.out, "p2s_filter_box_lid.stl"))
    # STLs are exported in print orientation; rebuild assembly placement
    body.apply_translation(-body.bounds[0])
    lid.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
    lid.apply_translation([0, 0, p.D + p.lid_t - lid.bounds[1][2]])
    write_sheet(p, body, lid, a.out)


if __name__ == "__main__":
    main()