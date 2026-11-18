"""Generate the skin layout illustration; optional dependency: CairoSVG."""
from pathlib import Path
import cairosvg

def rect(x,y,w,h,c,r=0): return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{c}"/>'

def line(x1,y1,x2,y2,c,w=1): return f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" stroke="{c}" stroke-width="{w}"/>'

def dot(x,y,r,c): return f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c}"/>'

def mixer(bg, panel, colors, light=False, style="default"):
 s=rect(0,0,160,120,bg)+rect(0,0,160,16,panel)
 for x in [8,17,26]: s+=dot(x,8,2,"#77818a")
 s+=rect(116,5,30,5,"#50606a",2)
 for i,x in enumerate([22,47,72,97,122]):
  c=colors[i%len(colors)];s+=rect(x,23,17,92,panel,2)+rect(x+3,28,11,4,c,1)+rect(x+3,38,11,9,"#41474a",1)+rect(x+3,50,11,9,"#41474a",1)
  s+=rect(x+7,66,3,37,"#586064",1)+rect(x+4,77+(i%3)*5,9,7,"#e6e5dc",2)+rect(x+3,108,11,3,c,1)
 return s

def node():
 s=rect(0,0,160,120,"#17191c")
 for d,c in [("M47 35 C68 35 68 50 90 50","#6388a4"),("M47 81 C71 81 71 66 90 66","#6db49c"),("M109 58 C125 58 122 76 139 76","#c69767")]:s+=f'<path d="{d}" fill="none" stroke="{c}" stroke-width="2"/>'
 for x,y,w,h,c in [(14,23,34,26,"#6798b3"),(14,69,34,26,"#8c77aa"),(90,36,36,38,"#6aaf98"),(130,64,23,25,"#d0a76e")]:
  s+=rect(x,y,w,h,"#282d32",4)+rect(x+4,y+5,w-8,4,c,1)+rect(x+4,y+13,w-12,3,"#69747b",1)+dot(x+w,y+h/2,2.5,c)
 return s

ROOT=Path(__file__).resolve().parent.parent/"assets"
ROOT.mkdir(exist_ok=True)
mark=node()
svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120">{mark}</svg>'
(ROOT/"preview.svg").write_text(svg+"\n",encoding="utf-8")
cairosvg.svg2png(bytestring=svg.encode(),write_to=str(ROOT/"preview.png"),output_width=160,output_height=120)
