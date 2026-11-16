import { describe, expect, it } from 'vitest';
// @ts-expect-error The placement contract is shared with the desktop renderer.
import { inApproach, nextToBody } from '../web/framework/desktop-controls.js';
// @ts-expect-error Browser-only placement module.
import { controlPhoneRect } from '../web/framework/phone-layout.js';

describe('desktop controls placement', () => {
  const viewport = {width:640, height:440};
  const viewportEdge = {x:570, y:260, w:62, h:160};
  const menu = {width:318, height:310};

  it('opens toward the inside and stays inside the monitor', () => {
    expect(nextToBody(viewportEdge, 330, menu, viewport)).toEqual({left:242, top:122});
    expect(nextToBody({x:8,y:15,w:62,h:70}, 44, menu, viewport)).toEqual({left:80, top:8});
  });

  it('uses the configured panel size, fitting the other side or leaving the portrait composer clear', () => {
    const anchor = {x:440,y:220,w:100,h:160}, size = {width:410,height:560};
    const large = controlPhoneRect(anchor,{width:900,height:800},undefined,undefined,undefined,size);
    expect(large).toMatchObject({w:410,h:560,placement:'left'});
    const chat = {x:70,y:40,w:260,h:520}, chrome = {top:94,bottom:486};
    const compact = controlPhoneRect(chat,{width:400,height:600},chat,chrome,undefined,size);
    expect(compact).toMatchObject({w:380,y:94,placement:'floating'});
    expect(compact.y+compact.h).toBeLessThan(chrome.bottom);
    const dock = {left:310,right:730,top:655,bottom:710};
    const landscape = controlPhoneRect({x:650,y:480,w:70,h:200},{width:900,height:800},undefined,undefined,undefined,size,dock);
    expect(landscape.y+landscape.h).toBeLessThan(dock.top);
  });

  it('uses the clear side when a speech bubble overlaps the default side', () => {
    const box = {x:285,y:170,w:70,h:168};
    const bar = {width:130,height:44};
    const speech = {left:363,right:550,top:145,bottom:260};
    expect(nextToBody(box, 216, bar, viewport, speech)).toEqual({left:145, top:194});
  });

  it('keeps the button strip clear of both the speech bubble and the scene input', () => {
    const anchor = {x:235,y:105,w:70,h:155}, strip = {width:48,height:130};
    const blocked = [{left:310,right:480,top:95,bottom:245},{left:150,right:465,top:260,bottom:380}];
    expect(nextToBody(anchor,181,strip,viewport,blocked)).toEqual({left:177,top:116});
  });

  it('keeps the bar visible across the gap and ignores distant transparent areas', () => {
    const box = {x:290,y:170,w:60,h:150};
    const bar = {left:360,right:490,top:218,bottom:266};
    expect(inApproach({x:355,y:242}, box, bar)).toBe(true);
    expect(inApproach({x:355,y:200}, box, bar)).toBe(false);
    expect(inApproach({x:510,y:242}, box, bar)).toBe(false);
    expect(inApproach({x:325,y:165}, box, {left:290,right:420,top:116,bottom:160})).toBe(true);
  });
});
