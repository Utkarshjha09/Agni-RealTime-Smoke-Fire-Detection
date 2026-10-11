import { memo, useMemo } from "react";
import { StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

type Props = {
  /** The rover's /stream.mjpg, token included. */
  url: string;
  onLive: () => void;
  onError: (reason: string) => void;
  /** Pixel size of the camera frame, so boxes can be mapped onto the screen. */
  onFrameSize: (width: number, height: number) => void;
};

/** A frame older than this means the stream has stalled: report it rather than
 * leave a frozen picture on screen looking live. */
const STALL_MS = 4000;

/** The page that draws the stream. It reads the multipart body itself, using each
 * part's Content-Length, and paints every frame onto one canvas. Painting over
 * the last frame is why nothing blinks: there is never a moment with no picture,
 * unlike swapping an <img>, which Android blanks while the next frame loads. */
function pageFor(url: string): string {
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;height:100%;background:#101521;overflow:hidden}canvas{display:block;width:100vw;height:100vh}</style>
</head><body><canvas id="c"></canvas><script>
(function () {
  var URL_ = ${JSON.stringify(url)};
  var STALL_MS = ${STALL_MS};
  var canvas = document.getElementById("c");
  var ctx = canvas.getContext("2d");
  var lastFrame = 0, live = false, size = "", decoding = false, controller = null;
  function post(type, data) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, data: data })); }
  function fit() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  }
  addEventListener("resize", fit);
  fit();
  function draw(bitmap) {
    var cw = canvas.width, ch = canvas.height;
    // "cover", matching boxOnScreen() in native/domain/detectionView.ts.
    var scale = Math.max(cw / bitmap.width, ch / bitmap.height);
    var w = bitmap.width * scale, h = bitmap.height * scale;
    ctx.drawImage(bitmap, (cw - w) / 2, (ch - h) / 2, w, h);
    var s = bitmap.width + "x" + bitmap.height;
    if (s !== size) { size = s; post("size", { width: bitmap.width, height: bitmap.height }); }
    if (bitmap.close) bitmap.close();
    if (!live) { live = true; post("live"); }
  }
  var HEADER_END = [13, 10, 13, 10];
  function indexOf(buf, pattern) {
    outer: for (var i = 0; i <= buf.length - pattern.length; i++) {
      for (var j = 0; j < pattern.length; j++) if (buf[i + j] !== pattern[j]) continue outer;
      return i;
    }
    return -1;
  }
  function concat(a, b) { var out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out; }
  var decoder = new TextDecoder();
  async function run() {
    controller = new AbortController();
    var buf = new Uint8Array(0);
    try {
      var res = await fetch(URL_, { cache: "no-store", signal: controller.signal });
      if (res.status === 401) throw new Error("wrong access token");
      if (!res.ok) throw new Error("HTTP " + res.status);
      var reader = res.body.getReader();
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) throw new Error("the rover ended the stream");
        buf = concat(buf, chunk.value);
        while (true) {
          var headerEnd = indexOf(buf, HEADER_END);
          if (headerEnd < 0) break;
          var match = /content-length:\\s*(\\d+)/i.exec(decoder.decode(buf.subarray(0, headerEnd)));
          var start = headerEnd + 4;
          if (!match) { buf = buf.slice(start); continue; }
          var length = +match[1];
          if (buf.length < start + length) break;
          var jpeg = buf.slice(start, start + length);
          buf = buf.slice(start + length);
          lastFrame = Date.now();
          // Skip a frame rather than queue it behind a slow decode, so the
          // picture never falls behind what the camera sees.
          if (!decoding) {
            decoding = true;
            createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
              .then(draw, function () {})
              .then(function () { decoding = false; });
          }
        }
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
      post("error", String((error && error.message) || error));
    }
  }
  setInterval(function () {
    if (lastFrame && Date.now() - lastFrame > STALL_MS) {
      lastFrame = 0;
      post("error", "no frames for " + STALL_MS / 1000 + "s");
      if (controller) controller.abort();
    }
  }, 1000);
  run();
})();
</script></body></html>`;
}

export const LiveStream = memo(function LiveStream({ url, onLive, onError, onFrameSize }: Props) {
  const source = useMemo(() => ({ html: pageFor(url) }), [url]);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      if (message.type === "live") onLive();
      if (message.type === "error") onError(String(message.data));
      if (message.type === "size") onFrameSize(Number(message.data.width), Number(message.data.height));
    } catch {
      // A malformed message from the page must not take the cockpit down.
    }
  };

  return (
    <WebView
      source={source}
      originWhitelist={["*"]}
      onMessage={onMessage}
      onError={event => onError(event.nativeEvent.description)}
      // The video is a backdrop: every touch belongs to the controls above it.
      pointerEvents="none"
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      javaScriptEnabled
      mixedContentMode="always"
      style={styles.view}
      containerStyle={StyleSheet.absoluteFill}
      accessibilityLabel="Live rover camera"
    />
  );
});

const styles = StyleSheet.create({
  view: { flex: 1, backgroundColor: "#101521" },
});
