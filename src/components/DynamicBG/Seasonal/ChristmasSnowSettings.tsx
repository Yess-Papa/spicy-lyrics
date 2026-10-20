import { useStore } from "@nanostores/react";
import { persistAtom } from "../../../utils/stores.ts";
import { Select, Slider, Toggle } from "../../ReactComponents/SettingsPanel/components.tsx";
import type { GroupDef, SectionDef } from "../../ReactComponents/SettingsPanel/model.ts";

// Seasonal: kept beside ChristmasSnow.ts so the whole feature, its settings tab included,
// can be removed after Christmas by deleting this folder and its imports.

/** Flake count, as a percentage of the default. */
export const $snowAmount = persistAtom<number>("christmasSnowAmount", 100);
export const $snowFrost = persistAtom<boolean>("christmasSnowFrost", true);
export const $snowReactsToMusic = persistAtom<boolean>("christmasSnowReactsToMusic", true);

export type SnowWhen = "christmas" | "all" | "none";
const SNOW_WHEN: readonly SnowWhen[] = ["christmas", "all", "none"];
export const $snowWhen = persistAtom<SnowWhen>("christmasSnowWhen", "christmas");

/** The saved choice, or the default when it's one this version doesn't offer. */
export function getSnowWhen(): SnowWhen {
  const when = $snowWhen.get();
  return SNOW_WHEN.includes(when) ? when : "christmas";
}

/** Greys out the rows below When to Snow while it's set to No songs. */
const useSnowOff = () => useStore($snowWhen) === "none" && "Snow is off: When to Snow is set to No songs.";

// Built once: the Control components must keep their identity across renders.
const group: GroupDef = {
  title: "Snow",
  settings: [
    {
      id: "christmasSnowWhen",
      label: "When to Snow",
      description: "Which songs it snows on.",
      keywords: "christmas snow songs all none off season holiday",
      Control: ({ label }) => {
        useStore($snowWhen);
        return (
          <Select
            label={label}
            value={getSnowWhen()}
            options={[...SNOW_WHEN]}
            labels={["Christmas Songs Only", "All songs", "No songs"]}
            onChange={(v) => $snowWhen.set(v as SnowWhen)}
          />
        );
      },
    },
    {
      id: "christmasSnowAmount",
      label: "Snow Amount",
      description: "How heavily it snows.",
      keywords: "christmas snow flakes density amount",
      stacked: true,
      useDisabled: useSnowOff,
      Control: ({ disabled, label }) => (
        <Slider
          label={label}
          value={useStore($snowAmount)}
          min={25}
          max={200}
          step={25}
          defaultValue={100}
          unit="%"
          onChange={(v) => $snowAmount.set(v)}
          disabled={disabled}
        />
      ),
    },
    {
      id: "christmasSnowReactsToMusic",
      label: "Snow Reacts to Music",
      description:
        "The snow falls faster and blows harder on loud parts, and eases off in quiet ones. Off, it falls at one steady pace.",
      keywords: "christmas snow music beat wind speed",
      useDisabled: useSnowOff,
      Control: ({ disabled, label }) => (
        <Toggle
          label={label}
          checked={useStore($snowReactsToMusic)}
          onChange={(v) => $snowReactsToMusic.set(v)}
          disabled={disabled}
        />
      ),
    },
    {
      id: "christmasSnowFrost",
      label: "Frost",
      description: "Frost around the edges of the page and the Now Playing sidebar while it snows.",
      keywords: "christmas snow frost ice edges",
      useDisabled: useSnowOff,
      Control: ({ disabled, label }) => (
        <Toggle label={label} checked={useStore($snowFrost)} onChange={(v) => $snowFrost.set(v)} disabled={disabled} />
      ),
    },
  ],
};

// A snowflake, on the sidebar icons' 16px grid and 1.5px stroke.
const ChristmasIcon = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 1.75v12.5M2.6 4.875l10.8 6.25M2.6 11.125l10.8-6.25M6.25 2.75 8 4.25l1.75-1.5M6.25 13.25 8 11.75l1.75 1.5" />
  </svg>
);

/** Settings → Christmas: everything the seasonal snow has, "No songs" included as its off switch. */
export const christmasSection: SectionDef = {
  id: "christmas",
  title: "Christmas",
  icon: ChristmasIcon,
  intro: "Seasonal extras for Christmas songs, here until the new year.",
  groups: () => [group],
};
