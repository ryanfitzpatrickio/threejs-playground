#!/usr/bin/env python3
"""Render kept-triangle soup (from probe-loop-cut-candidate.mjs) neck closeups."""
import json, sys
import numpy as np
from PIL import Image, ImageDraw

tris_path, prefix = sys.argv[1], sys.argv[2]
kept = np.array(json.load(open(tris_path)), dtype=np.float32).reshape(-1, 3, 3)

def render(tris, view, path, center, scale, size=(760, 700)):
    img = Image.new('RGB', size, (18, 18, 22))
    draw = ImageDraw.Draw(img, 'RGBA')
    views = {
        'front': (np.array([-1,0,0.]), np.array([0,1,0.]), np.array([0,0,1.])),
        'back':  (np.array([1,0,0.]),  np.array([0,1,0.]), np.array([0,0,-1.])),
        'sideL': (np.array([0,0,1.]),  np.array([0,1,0.]), np.array([-1,0,0.])),
        'sideR': (np.array([0,0,-1.]), np.array([0,1,0.]), np.array([1,0,0.])),
        'threeq':(np.array([-0.6,0.3,0.6]), np.array([0.25,0.9,-0.25]), np.array([0.55,0.45,0.55])),
    }
    right, up, depth = [v/np.linalg.norm(v) for v in views[view]]
    light = np.array([0.4, 0.7, 0.6]); light /= np.linalg.norm(light)
    P = tris - np.array(center)
    sx = P @ right * scale + size[0]/2
    sy = -P @ up * scale + size[1]/2
    sd = P @ depth
    order = np.argsort(sd.mean(axis=1))
    e1 = tris[:,1]-tris[:,0]; e2 = tris[:,2]-tris[:,0]
    n = np.cross(e1, e2); nl = np.linalg.norm(n, axis=1); nl[nl==0]=1; n /= nl[:, None]
    shade = np.abs(n @ light)*0.65 + 0.35
    base = np.array((205, 150, 160))
    for i in order:
        c = base * shade[i]
        draw.polygon([(sx[i,0], sy[i,0]), (sx[i,1], sy[i,1]), (sx[i,2], sy[i,2])],
                     fill=(int(c[0]), int(c[1]), int(c[2]), 255))
    img.save(path)

mask = kept[:, :, 1].max(axis=1) > 2.3
neck = kept[mask]
for view in ['front', 'back', 'sideL', 'sideR', 'threeq']:
    render(neck, view, f'{prefix}-{view}.png', (0, 2.72, 0), 700)
render(kept, 'front', f'{prefix}-full.png', (0, 2.0, 0), 220, size=(760, 900))
print('rendered', len(neck), 'neck tris')
