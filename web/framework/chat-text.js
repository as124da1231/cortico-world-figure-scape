export const SCENE_CHAT_TEXT_MAX = 500;
export const CHAT_TEXT_MAX = 4000;

export function chatTextLengthNote(value, limit, text) {
  const length = value.trim().length;
  return length > limit ? text(
    `消息最多 ${limit} 字，当前 ${length} 字。请缩短后发送，输入已保留。`,
    `Messages can contain up to ${limit} characters. This draft has ${length}. Shorten it to send.`,
  ) : '';
}
