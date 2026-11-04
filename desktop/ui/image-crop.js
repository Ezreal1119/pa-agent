'use strict';
// Manual rectangular selection only. Pixels are cropped by the authenticated backend.
window.CkdCropDialog = class {
  constructor() {
    this.dialog = document.createElement('dialog'); this.dialog.className = 'crop-dialog';
    this.dialog.innerHTML = '<h2>裁剪图片</h2><p class="muted">拖动四角或边缘调整范围，拖动选框移动。灰色区域不会保留。</p><div class="crop-canvas-wrap"><canvas aria-label="图片裁剪范围" tabindex="0"></canvas></div><p class="crop-size small muted"></p><p class="crop-error error" role="alert"></p><div class="buttons"><button data-action="all">选中全图</button><button data-action="restore">恢复原图</button><button data-action="cancel">取消</button><button data-action="confirm" class="primary">确定裁剪</button></div>';
    document.body.append(this.dialog); this.canvas = this.dialog.querySelector('canvas');
    this.canvas.addEventListener('pointerdown', event => this.down(event));
    this.canvas.addEventListener('pointermove', event => this.move(event));
    for (const type of ['pointerup','pointercancel']) this.canvas.addEventListener(type, () => { this.drag = null; });
    this.canvas.addEventListener('keydown', event => {
      if (!this.rect || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const step = event.shiftKey ? 10 : 1;
      this.rect.left = Math.max(0, Math.min(this.image.width-this.rect.width, this.rect.left+(event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0)));
      this.rect.top = Math.max(0, Math.min(this.image.height-this.rect.height, this.rect.top+(event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0))); this.draw();
    });
    this.dialog.querySelector('[data-action="all"]').onclick = () => { this.rect={left:0,top:0,width:this.image.width,height:this.image.height};this.draw(); };
    this.dialog.querySelector('[data-action="cancel"]').onclick = () => this.close();
    this.dialog.querySelector('[data-action="restore"]').onclick = () => this.submit(null);
    this.dialog.querySelector('[data-action="confirm"]').onclick = () => this.submit({...this.rect});
    this.dialog.addEventListener('cancel',event=>{if(this.saving)event.preventDefault();});
  }
  async open(dataUrl, rect, save, sourceSize) {
    const image = new Image(); image.src=dataUrl; await image.decode();
    this.image=image;this.sourceSize=sourceSize??{width:image.width,height:image.height};this.save=save;this.drag=null;this.rect=rect?{...rect}:{left:0,top:0,width:image.width,height:image.height};
    this.canvas.width=image.width;this.canvas.height=image.height;
    this.dialog.querySelector('.crop-error').textContent='';this.dialog.showModal();this.draw();this.canvas.focus();
  }
  close(force = false) { if(force || !this.saving)this.dialog.close(); }
  async submit(rect) {
    if(this.saving)return;this.saving=true;for(const button of this.dialog.querySelectorAll('button'))button.disabled=true;
    try {await this.save(rect);this.dialog.close();}
    catch(error){this.dialog.querySelector('.crop-error').textContent=error.message;}
    finally{this.saving=false;for(const button of this.dialog.querySelectorAll('button'))button.disabled=false;}
  }
  point(event) {const b=this.canvas.getBoundingClientRect();return {x:Math.round((event.clientX-b.left)*this.canvas.width/b.width),y:Math.round((event.clientY-b.top)*this.canvas.height/b.height)};}
  hit(p) {
    const r=this.rect,t=12*this.canvas.width/this.canvas.getBoundingClientRect().width;
    const left=Math.abs(p.x-r.left)<t,right=Math.abs(p.x-r.left-r.width)<t,top=Math.abs(p.y-r.top)<t,bottom=Math.abs(p.y-r.top-r.height)<t;
    if(p.x<r.left-t||p.x>r.left+r.width+t||p.y<r.top-t||p.y>r.top+r.height+t)return '';
    return (top?'n':bottom?'s':'')+(left?'w':right?'e':'')||'move';
  }
  down(event) {if(this.saving)return;const p=this.point(event),handle=this.hit(p);if(!handle)return;event.preventDefault();this.canvas.setPointerCapture(event.pointerId);this.drag={p,handle,start:{...this.rect}};}
  move(event) {
    if(!this.rect||this.saving)return;const p=this.point(event);
    if(!this.drag){const h=this.hit(p);this.canvas.style.cursor=h==='move'?'move':h==='nw'||h==='se'?'nwse-resize':h==='ne'||h==='sw'?'nesw-resize':h==='n'||h==='s'?'ns-resize':h?'ew-resize':'default';return;}
    const {start:r,p:origin,handle:h}=this.drag,dx=p.x-origin.x,dy=p.y-origin.y;
    if(h==='move'){this.rect={...r,left:Math.max(0,Math.min(this.image.width-r.width,r.left+dx)),top:Math.max(0,Math.min(this.image.height-r.height,r.top+dy))};}
    else {let l=r.left,t=r.top,right=l+r.width,bottom=t+r.height;
      if(h.includes('w'))l=Math.max(0,Math.min(right-1,l+dx));if(h.includes('e'))right=Math.max(l+1,Math.min(this.image.width,right+dx));
      if(h.includes('n'))t=Math.max(0,Math.min(bottom-1,t+dy));if(h.includes('s'))bottom=Math.max(t+1,Math.min(this.image.height,bottom+dy));
      this.rect={left:l,top:t,width:right-l,height:bottom-t};
    }this.draw();
  }
  draw() {
    const ctx=this.canvas.getContext('2d'),r=this.rect,w=this.canvas.width,h=this.canvas.height,scale=w/this.canvas.getBoundingClientRect().width;
    ctx.clearRect(0,0,w,h);ctx.drawImage(this.image,0,0);ctx.fillStyle='rgba(20,24,22,.65)';
    ctx.fillRect(0,0,w,r.top);ctx.fillRect(0,r.top+r.height,w,h-r.top-r.height);ctx.fillRect(0,r.top,r.left,r.height);ctx.fillRect(r.left+r.width,r.top,w-r.left-r.width,r.height);
    ctx.strokeStyle='#c7e4b5';ctx.lineWidth=2*scale;ctx.strokeRect(r.left,r.top,r.width,r.height);ctx.fillStyle='#c7e4b5';
    const size=10*scale;for(const x of [r.left,r.left+r.width])for(const y of [r.top,r.top+r.height])ctx.fillRect(x-size/2,y-size/2,size,size);
    const sw=this.sourceSize.width,sh=this.sourceSize.height;
    const rw=Math.min(sw,Math.ceil((r.left+r.width)*sw/w))-Math.floor(r.left*sw/w),rh=Math.min(sh,Math.ceil((r.top+r.height)*sh/h))-Math.floor(r.top*sh/h);
    this.dialog.querySelector('.crop-size').textContent=`保留 ${rw} × ${rh} 原图像素；预览可能缩小，裁剪后不重新评分。`;
  }
};
