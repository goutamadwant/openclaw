// Telegram delivery treats a final standalone notify=false line as silent-send metadata.
const TRAILING_NOTIFY_FALSE_MARKER_RE = /(^|\r?\n)[ \t]*notify=false[ \t]*(?:\r?\n[ \t]*)*$/;

export function consumeTrailingNotifyFalseMarker(params: { text: string; silent?: boolean }): {
  text: string;
  silent?: boolean;
} {
  const match = TRAILING_NOTIFY_FALSE_MARKER_RE.exec(params.text);
  if (!match) {
    return params;
  }
  return {
    text: params.text.slice(0, match.index).trimEnd(),
    silent: true,
  };
}
