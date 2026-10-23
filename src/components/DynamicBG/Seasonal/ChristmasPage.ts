import Global from "../../Global/Global.ts";
import { PageContainer } from "../../Pages/PageView.ts";
import { IsChristmasTrack } from "./ChristmasSnow.ts";
import { $frostedLyrics } from "./ChristmasSnowSettings.tsx";

/**
 * Gives Christmas songs an icy glow on the line being sung, through a class on
 * #SpicyLyricsPage that ChristmasPage.css styles. It doesn't need the animated
 * background.
 */
export function UpdateChristmasPage() {
  if (!PageContainer) return;
  PageContainer.classList.toggle("ChristmasFrostedLyrics", IsChristmasTrack() && $frostedLyrics.get());
}

Global.Event.listen("page:open", UpdateChristmasPage);
Global.Event.listen("playback:songchange", UpdateChristmasPage);
$frostedLyrics.listen(UpdateChristmasPage);
