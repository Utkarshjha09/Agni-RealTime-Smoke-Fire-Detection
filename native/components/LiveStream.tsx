import { memo, useMemo } from "react";
import { StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

type Props = {
  /** The rover's /stream.mjpg, with a one-time ticket and the overlay choice. */
  url: string;
  onLive: () => void;
  onError: (reason: string) => void;
  /** Pixel size of the camera frame. */
  onFrameSize: (width: number, height: number) => void;
};

/** The page that shows the stream: one <img> pointed at it, exactly as a browser
 * shows model/live_test.py. The browser engine decodes MJPEG natively and keeps
 * the last frame on screen until the next one is ready, so the video neither
 * blinks nor waits on JavaScript. An earlier version read the stream in script and
 * painted each frame itself, which added work on the phone for every frame.
 *
 * A stall is not detected here: the rover reports how old its latest camera frame
 * is in telemetry, and the app acts on that. */
function pageFor(url: string): string {
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  html,body{margin:0;height:100%;background:#101521;overflow:hidden}
  img{display:block;width:100vw;height:100vh;object-fit:cover}
</style>
</head><body><img id="v" alt=""><script>
(function () {
  var img = document.getElementById("v");
  function post(type, data) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, data: data })); }
  img.onerror = function () { post("error", "the video stream could not be opened"); };
  img.src = ${JSON.stringify(url).replace(/</g, "\\u003c")};
  // naturalWidth turns non-zero once the first frame has been decoded. It is
  // the one signal every engine gives for a multipart image, which may never
  // fire a load event of its own.
  var waited = 0;
  var check = setInterval(function () {
    if (img.naturalWidth > 0) {
      clearInterval(check);
      post("size", { width: img.naturalWidth, height: img.naturalHeight });
      post("live");
    } else if ((waited += 250) >= 8000) {
      clearInterval(check);
      post("error", "no video frame arrived in 8 s");
    }
  }, 250);
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
