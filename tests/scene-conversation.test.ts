// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Browser-only views.
import { createLandscapeChat } from '../web/framework/landscape-chat.js';
// @ts-expect-error Browser-only views.
import { createPhoneChat } from '../web/framework/phone-chat.js';

const text = (zh:string) => zh;
const area = {x:0,y:0,w:640,h:360};
afterEach(() => document.body.replaceChildren());

it('keeps both landscape composers visible and keeps their drafts through scene changes', () => {
  const bubble = document.body.appendChild(document.createElement('div'));
  const send = vi.fn(() => true);
  const chat = createLandscapeChat({doc:document,bubble,text,send,connectMic:vi.fn(),syncMic:vi.fn()});
  const render = (mode:string) => chat.render({mode,area,online:true,switching:false,lines:[]});
  render('room');
  const room = document.querySelector<HTMLElement>('[data-landscape-chat=room]')!;
  const input = room.querySelector('textarea')!;
  expect(room.hidden || input.closest('form')!.hidden).toBe(false);
  expect(room.querySelector('.landscape-chat-reply')!.firstElementChild).toBe(bubble);
  input.value = '房间里的草稿';
  input.dispatchEvent(new Event('input'));
  render('wallpaper');
  const screen = document.querySelector<HTMLElement>('[data-landscape-chat=wallpaper]')!;
  expect(screen.hidden).toBe(false);
  expect(screen.querySelector('.landscape-chat-reply')!.firstElementChild).toBe(bubble);
  expect(screen.querySelector('textarea')!.value).toBe('');
  render('room');
  expect(input.value).toBe('房间里的草稿');
  input.closest('form')!.requestSubmit();
  const sent = (send.mock.calls as unknown[][]).at(-1)?.[0] as {request:string};
  expect(sent).toMatchObject({t:'phone-message',scene:'room',text:'房间里的草稿'});
  chat.receipt({request:sent.request,ok:false});
  expect(input.value).toBe('房间里的草稿');
  input.closest('form')!.requestSubmit();
  const second = (send.mock.calls as unknown[][]).at(-1)?.[0] as {request:string};
  chat.receipt({request:second.request,ok:true,cursor:3});
  expect(input.value).toBe('');
  render('desktop');
  expect(bubble.parentElement).toBe(document.body);
});

it('shows the ongoing reply once and reveals it in portrait history when speech ends', () => {
  const bubble = document.body.appendChild(document.createElement('div'));
  const chat = createPhoneChat({doc:document,bubble,text,send:()=>true,connectMic:vi.fn(),syncMic:vi.fn()});
  const render = (speaking:number[]) => chat.render({active:true,area:{...area,w:320,h:569},name:'Coo',online:true,speaking});
  render([42]);
  chat.history({messages:[{cursor:42,side:'pet',text:'同一句'}],withdrawn:[],replace:true});
  const history = chat.log.querySelector('.phone-chat-message') as HTMLElement;
  expect(history.hidden).toBe(true);
  render([]);
  expect(history.hidden).toBe(false);
});

it('keeps the temporary microphone bubble by the composer and out of portrait history', () => {
  const bubble = document.body.appendChild(document.createElement('div'));
  const listening = document.body.appendChild(document.createElement('div'));
  listening.className = 'bubble heard';
  listening.textContent = '刚刚说的话';
  const chat = createPhoneChat({doc:document,bubble,text,send:()=>true,connectMic:vi.fn(),syncMic:vi.fn()});
  const render = (active:boolean) => chat.render({active,area:{...area,w:320,h:569},name:'Coo',online:true});
  render(true);
  chat.attachListening(listening);
  chat.history({messages:[{cursor:3,side:'pet',text:'之前的回复'}],withdrawn:[],replace:true});
  expect(chat.log.contains(listening)).toBe(false);
  expect(chat.frame.querySelector('.phone-chat-voice')?.firstElementChild).toBe(listening);
  expect(chat.log.textContent).toContain('之前的回复');
  render(false);
  expect(listening.parentElement).toBe(document.body);
});

it('shows the live room exchange without mounting a scrolling conversation log', () => {
  const bubble = document.body.appendChild(document.createElement('div'));
  bubble.className = 'bubble say';
  bubble.textContent = '我在床上躺好啦。';
  const send = vi.fn(() => true);
  const chat = createLandscapeChat({doc:document,bubble,text,send,connectMic:vi.fn(),syncMic:vi.fn()});
  chat.render({mode:'room',area,online:true,switching:false,lines:[]});
  const room = document.querySelector('[data-landscape-chat=room]')!;
  expect(room.querySelector('.landscape-chat-reply')?.firstElementChild).toBe(bubble);
  expect(room.querySelector('[role=log]')).toBeNull();
  expect(send).not.toHaveBeenCalled();
  bubble.hidden = true;
  bubble.textContent = '';
  expect(room.textContent).not.toContain('我在床上躺好啦');
});

it('retries the portrait history request until the scene is ready and again after reconnect', () => {
  vi.useFakeTimers();
  try {
    const bubble = document.body.appendChild(document.createElement('div'));
    const send = vi.fn(() => true);
    const chat = createPhoneChat({doc:document,bubble,text,send,connectMic:vi.fn(),syncMic:vi.fn()});
    const render = (online:boolean, switching = false) => chat.render({active:true,area:{...area,w:320,h:569},name:'Coo',online,switching});
    render(true,true);
    expect(send).not.toHaveBeenCalled();
    render(true);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    render(true);
    expect(send).toHaveBeenCalledTimes(2);
    chat.history({messages:[],withdrawn:[],replace:true});
    vi.advanceTimersByTime(1000);
    render(true);
    expect(send).toHaveBeenCalledTimes(2);
    render(false);
    render(true);
    expect(send).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});

