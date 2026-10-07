import AIVisual from "./AIVisual";
import OmniFlowBot from "../OmniFlowBot/OmniFlowBot";
import { pickBotChannels } from "../OmniFlowBot/botChannels";
import { heroVisualAsset } from "../../../lib/marketing/site";
import { getCopy, getMarketingList } from "../../../lib/marketing/cms";

const delay = (ms: number) => ({ ["--of-delay" as string]: `${ms}ms` });

/**
 * Hero visual slot (§247/§248): the OmniFlowBot with its channel nodes, or a
 * configured image/video (`heroVisualAsset`) in its place. Same square
 * box either way, so swapping the visual never shifts the layout. Bot
 * lines are CMS copy (home_sections.hero.bot); channel nodes follow the
 * honest statuses of the integrations list: offered channels on the
 * right, upcoming ones on the left with a Soon badge.
 */
export default async function HeroVisual() {
  const [home, integrations] = await Promise.all([getCopy("home_sections"), getMarketingList("integrations")]);
  const { primary, secondary, more } = pickBotChannels(integrations);
  return (
    <div
      className="of-enter relative mx-auto w-full max-w-[400px] sm:max-w-[500px] lg:max-w-[560px]"
      style={delay(160)}
    >
      {heroVisualAsset ? (
        <AIVisual asset={heroVisualAsset} fallback={null} priority />
      ) : (
        <OmniFlowBot
          label={home.hero.visualLabel}
          copy={home.hero.bot}
          primary={primary}
          secondary={secondary}
          more={more}
        />
      )}
    </div>
  );
}
