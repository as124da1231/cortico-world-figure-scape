import { createSceneChatInput } from './scene-chat-input.js';

export function createLandscapeChat({ doc, bubble, text, send, connectMic, syncMic, focus, delivered, releaseMic }) {
  const placeholder = doc.createComment('landscape bubble');
  bubble.before(placeholder);
  const panels = new Map(['room','wallpaper'].map(mode => [mode, createPanel(mode)]));
  let active = null, areaKey = '';

  function createPanel(mode) {
    const node = (tag, className) => Object.assign(doc.createElement(tag), {className});
    const frame = node('section','landscape-chat');
    frame.dataset.landscapeChat = mode;
    frame.hidden = true;
    const rail = node('div','landscape-chat-rail');
    const reply = node('div','landscape-chat-reply');
    const spoken = node('div','landscape-chat-spoken');
    rail.append(reply,spoken);

    const dock = node('div','landscape-chat-dock');
    const form = node('form','landscape-chat-form');
    form.id = 'landscape-compose-' + mode;
    const input = node('textarea','landscape-chat-input');
    input.rows = 1;
    input.maxLength = 500;
    input.autocomplete = 'off';
    const submit = node('button','landscape-chat-send');
    submit.type = 'submit';
    const mic = node('button','landscape-chat-mic');
    mic.type = 'button';
    mic.dataset.action = 'voice';
    const icon = node('span','ic');
    icon.setAttribute('aria-hidden','true');
    mic.append(icon);
    connectMic(mic);
    const feedback = node('p','landscape-chat-feedback');
    feedback.setAttribute('role','status');
    form.append(input, submit, mic, feedback);
    dock.append(form);
    frame.append(rail, dock);
    doc.body.append(frame);

    const composer = createSceneChatInput({doc,text,send,mode,form,input,submit,feedback,delivered});
    function open() { focus?.(); composer.focus(); }
    form.addEventListener('keydown',event => {
      if (event.key === 'Escape' && !event.isComposing) {event.stopPropagation();input.blur();}
    });
    let language;
    return {
      frame, reply, spoken, composer, open, release:() => releaseMic?.(form),
      sync(online,switching) {
        composer.setOnline(online);
        composer.setBlocked(switching);
        syncMic(mic);
        if (language !== doc.documentElement.lang) {
          language = doc.documentElement.lang;
          frame.setAttribute('aria-label',mode === 'room' ? text('小屋对话','Room conversation') : text('壁纸对话','Wallpaper conversation'));
          input.placeholder = mode === 'room' ? text('和角色聊一聊…','Say something…') : text('发消息…','Message…');
          input.setAttribute('aria-label',text('输入消息','Enter a message'));
          composer.sync();
        }
      },
    };
  }

  function restoreLines(panel) {
    for (const element of [...panel.spoken.children]) doc.body.append(element);
  }
  return {
    open() { active?.open(); },
    failed() { for (const panel of panels.values()) panel.composer.failed(); },
    receipt(message) { for (const panel of panels.values()) panel.composer.receipt(message); },
    render({mode,area,online,switching,lines,inputOpen}) {
      const next = panels.get(mode) ?? null;
      if (active !== next) {
        if (active) {
          active.release();
          restoreLines(active);
          active.frame.hidden = true;
          placeholder.after(bubble);
        }
        active = next;
        areaKey = '';
        if (active) {
          active.reply.append(bubble);
          active.frame.hidden = false;
        }
      }
      if (!active) return;
      const {x,y,w,h}=area;
      const geometry = [x,y,w,h].join(',');
      if (geometry !== areaKey) {
        areaKey = geometry;
        Object.assign(active.frame.style, { left:x+'px',top:y+'px',width:w+'px',height:h+'px' });
        active.frame.style.setProperty('--landscape-height',h+'px');
      }
      active.sync(online,switching);
      active.frame.classList.toggle('has-legacy-input',inputOpen);
      const visible = lines.slice(-2).map(line => line.el);
      for (const el of [...active.spoken.children]) if (!visible.includes(el)) {doc.body.append(el);el.hidden=true;}
      for (const el of visible) {
        if (el.parentElement !== active.spoken) active.spoken.append(el);
        el.hidden=false;
      }
    },
  };
}

