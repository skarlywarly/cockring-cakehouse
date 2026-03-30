import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  type TextChannel,
} from "discord.js";

const API_URL =
  "https://www.rugpullbakery.com/api/trpc/leaderboard.getTopBakeries?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22limit%22%3A15%7D%7D%7D";

const SEASON_API_URL =
  "https://www.rugpullbakery.com/api/trpc/leaderboard.getActiveSeason?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%7D";

const ETH_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd";

const ONE_HOUR_MS = 60 * 60 * 1000;
const FEED_POLL_MS = 30 * 1000;
const OUR_BAKERY_ID = 58;

const ACTIVITY_FEED_URL =
  "https://www.rugpullbakery.com/api/trpc/leaderboard.getGlobalActivityFeed?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22limit%22%3A20%7D%7D%7D";

interface FeedEvent {
  type: string;
  user: string;
  bakeryId: number;
  bakeryName: string;
  eventBakeryId: number;
  eventBakeryName: string;
  event: string;
  timestamp: string;
  boostTypeName: string | null;
  boostMultiplierBps: number | null;
  boostDuration: string | null;
  success: boolean | null;
}

interface Bakery {
  id: number;
  name: string;
  memberCount: number;
  activeCookCount: number;
  txCount: string;
  activeBuffs: { name: string; multiplierBps: number; endTime: string }[];
  activeDebuffs: { name: string; debuffBps: number; endTime: string }[];
}

interface TrpcBatchResponse {
  result: {
    data: {
      json: {
        items: Bakery[];
      };
    };
  };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function fetchTopBakeries(): Promise<Bakery[]> {
  const res = await fetch(API_URL);
  if (!res.ok) {
    res.body?.cancel();
    throw new Error(`API returned ${res.status}`);
  }
  const data = (await res.json()) as TrpcBatchResponse[];
  return data[0].result.data.json.items.slice(0, 5);
}

let cachedEthPrice = 0;
let ethPriceFetchedAt = 0;
const ETH_PRICE_TTL = 5 * 60 * 1000;

async function getEthPrice(): Promise<number> {
  if (cachedEthPrice > 0 && Date.now() - ethPriceFetchedAt < ETH_PRICE_TTL) {
    return cachedEthPrice;
  }
  const res = await fetch(ETH_PRICE_URL);
  if (!res.ok) {
    res.body?.cancel();
    if (cachedEthPrice > 0) return cachedEthPrice;
    throw new Error(`CoinGecko returned ${res.status}`);
  }
  const data = (await res.json()) as { ethereum: { usd: number } };
  cachedEthPrice = data.ethereum.usd;
  ethPriceFetchedAt = Date.now();
  return cachedEthPrice;
}

async function fetchSeasonInfo(): Promise<{
  prizePoolStr: string;
  endTime: string;
}> {
  const [seasonRes, ethPrice] = await Promise.all([
    fetch(SEASON_API_URL),
    getEthPrice(),
  ]);
  if (!seasonRes.ok) {
    seasonRes.body?.cancel();
    throw new Error(`Season API returned ${seasonRes.status}`);
  }
  const seasonData = (await seasonRes.json()) as {
    result: { data: { json: { prizePool: string; endTime: string }[] } };
  }[];
  const season = seasonData[0].result.data.json[0];
  const eth = Number(BigInt(season.prizePool)) / 1e18;
  const usd = eth * ethPrice;
  const prizePoolStr = `${eth.toFixed(2)} ETH ($${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })})`;
  return { prizePoolStr, endTime: season.endTime };
}

function buildLeaderboardEmbed(
  bakeries: Bakery[],
  prizePool: string,
  endTime: string,
): EmbedBuilder {
  const medals = ["🥇", "🥈", "🥉", "4.", "5."];

  const lines = bakeries.map((b, i) => {
    const medal = medals[i] ?? `${i + 1}.`;
    let rate = 1;
    for (const buff of b.activeBuffs) rate *= buff.multiplierBps / 10000;
    for (const debuff of b.activeDebuffs) rate *= 1 - debuff.debuffBps / 10000;
    const pct = Math.round((rate - 1) * 100);
    const pctStr = pct >= 0 ? `+${pct}%` : `${pct}%`;
    const rateStr = `${rate.toFixed(2)}x (${pctStr})`;
    const cookies = Math.round(Number(BigInt(b.txCount)) / 10000);
    const cookiesStr =
      cookies >= 1_000_000
        ? `${(cookies / 1e6).toFixed(2)}M`
        : cookies >= 1_000
          ? `${(cookies / 1e3).toFixed(1)}K`
          : String(cookies);
    return [
      `${medal} **${b.name}** — ${rateStr}`,
      `╰ 🍪 ${cookiesStr} · 👥 ${b.memberCount} · 🧑‍🍳 ${b.activeCookCount} @ ${(b.activeCookCount * rate).toFixed(1)} · ⬆${b.activeBuffs.length} ⬇${b.activeDebuffs.length}`,
    ].join("\n");
  });

  return new EmbedBuilder()
    .setTitle("🍰 Top 5 Bakeries")
    .setDescription(
      `💰 Prize Pool: **${prizePool}**\n⏰ Season Ends: <t:${endTime}:R>\n\n${lines.join("\n\n") || "No data available."}`,
    )
    .setColor(0xf5a623)
    .setFooter({ text: "rugpullbakery.com" })
    .setTimestamp();
}

async function postLeaderboard(channel: TextChannel): Promise<void> {
  try {
    const [bakeries, { prizePoolStr, endTime }] = await Promise.all([
      fetchTopBakeries(),
      fetchSeasonInfo(),
    ]);
    const embed = buildLeaderboardEmbed(bakeries, prizePoolStr, endTime);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Failed to fetch leaderboard:", err);
    try {
      await channel.send("Failed to fetch the leaderboard. Try again later.");
    } catch {}
  }
}

async function resolveUsernames(
  addresses: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (addresses.length === 0) return map;
  const unique = [...new Set(addresses)];
  const encoded = encodeURIComponent(
    JSON.stringify({ "0": { json: { addresses: unique } } }),
  );
  const url = `https://www.rugpullbakery.com/api/trpc/profiles.getByAddresses?batch=1&input=${encoded}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      res.body?.cancel();
      return map;
    }
    const data = (await res.json()) as {
      result: {
        data: { json: { address: string; profile: { name: string } | null }[] };
      };
    }[];
    for (const entry of data[0].result.data.json) {
      const name = entry.profile?.name;
      if (name) map.set(entry.address, name);
    }
  } catch {
    /* fall back to truncated addresses */
  }
  return map;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

let lastSeenTimestamp = "0";
let polling = false;

async function pollActivityFeed(channel: TextChannel): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch(ACTIVITY_FEED_URL);
    if (!res.ok) {
      res.body?.cancel();
      return;
    }
    const data = (await res.json()) as {
      result: { data: { json: FeedEvent[] } };
    }[];
    const events = data[0].result.data.json;

    const nowSec = Math.floor(Date.now() / 1000);
    const oneMinuteAgo = String(nowSec - 60);

    const relevant = events
      .filter(
        (e) =>
          e.eventBakeryId === OUR_BAKERY_ID &&
          (e.type === "boost" || e.type === "rug") &&
          e.timestamp > lastSeenTimestamp &&
          e.timestamp >= oneMinuteAgo,
      )
      .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));

    const usernames = await resolveUsernames(relevant.map((e) => e.user));

    for (const e of relevant) {
      const icon = e.type === "boost" ? "⬆️" : "🔻";
      const status = e.success ? "✅" : "❌";
      const who = usernames.get(e.user) ?? shortAddr(e.user);
      const from =
        e.bakeryId !== e.eventBakeryId ? ` (from **${e.bakeryName}**)` : "";
      const bps = e.boostMultiplierBps
        ? `${(e.boostMultiplierBps / 100).toFixed(0)}%`
        : "";
      const embed = new EmbedBuilder()
        .setDescription(
          `${icon} ${status} **${who}** ${e.event} ${e.eventBakeryName}${from}\n` +
            `${e.boostTypeName ?? "Unknown"} · ${bps} · <t:${e.timestamp}:R>`,
        )
        .setColor(e.type === "boost" ? 0x2ecc71 : 0xe74c3c)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }

    const maxTimestamp = events.reduce(
      (max, e) => (e.timestamp > max ? e.timestamp : max),
      lastSeenTimestamp,
    );
    lastSeenTimestamp = maxTimestamp;
  } catch (err) {
    console.error("Failed to poll activity feed:", err);
  } finally {
    polling = false;
  }
}

const warnedExpiries = new Set<string>();

async function checkExpiringSoon(channel: TextChannel): Promise<void> {
  try {
    const bakeries = await fetchTopBakeries();
    const ours = bakeries.find((b) => b.id === OUR_BAKERY_ID);
    if (!ours) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const fiveMin = 5 * 60;

    const expiring: {
      name: string;
      type: "buff" | "debuff";
      endTime: string;
    }[] = [];

    for (const buff of ours.activeBuffs) {
      const end = Number(buff.endTime);
      const key = `buff:${buff.name}:${buff.endTime}`;
      if (end > nowSec && end - nowSec <= fiveMin && !warnedExpiries.has(key)) {
        expiring.push({ name: buff.name, type: "buff", endTime: buff.endTime });
        warnedExpiries.add(key);
      }
    }

    for (const debuff of ours.activeDebuffs) {
      const end = Number(debuff.endTime);
      const key = `debuff:${debuff.name}:${debuff.endTime}`;
      if (end > nowSec && end - nowSec <= fiveMin && !warnedExpiries.has(key)) {
        expiring.push({
          name: debuff.name,
          type: "debuff",
          endTime: debuff.endTime,
        });
        warnedExpiries.add(key);
      }
    }

    for (const e of expiring) {
      const icon = e.type === "buff" ? "⚠️ ⬆️" : "⚠️ 🔻";
      const label = e.type === "buff" ? "Buff" : "Debuff";
      const embed = new EmbedBuilder()
        .setDescription(
          `${icon} ${label} **${e.name}** expiring <t:${e.endTime}:R>`,
        )
        .setColor(e.type === "buff" ? 0xf39c12 : 0x27ae60)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error("Failed to check expiring buffs/debuffs:", err);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  const readyMessages = [
    "🍰 Ready to cook! Let's bake some cakes.",
    "🧑‍🍳 Oven preheated. Time to rise!",
    "🍪 Bakery bot reporting for duty!",
    "🔥 Fired up and ready to roll some dough.",
    "🎂 Let them eat cake — bot is live!",
  ];
  const readyMsg =
    readyMessages[Math.floor(Math.random() * readyMessages.length)];
  console.log(readyMsg);

  const channelId = process.env.CHANNEL_ID;
  if (!channelId) {
    console.warn("CHANNEL_ID not set — scheduled posts disabled.");
    return;
  }

  const raw = await client.channels.fetch(channelId).catch(() => null);
  if (!raw?.isTextBased() || !("send" in raw)) {
    console.warn("CHANNEL_ID does not point to a valid text channel.");
    return;
  }
  const channel = raw as TextChannel;

  await channel.send(readyMsg);

  postLeaderboard(channel);
  setInterval(() => postLeaderboard(channel), ONE_HOUR_MS);

  // Set baseline so we don't replay old events on startup
  await pollActivityFeed(channel);
  setInterval(() => pollActivityFeed(channel), FEED_POLL_MS);

  setInterval(() => checkExpiringSoon(channel), FEED_POLL_MS);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const cmd = message.content.trim().toLowerCase();
  if (cmd === "!lb") {
    await postLeaderboard(message.channel as TextChannel);
  } else if (cmd === "!join") {
    await message.channel.send(
      "https://x.com/Skarly/status/2037208078144463181",
    );
  } else if (cmd === "!git") {
    await message.channel.send(
      "https://github.com/skarlywarly/cockring-cakehouse",
    );
  } else if (cmd === "!buffs" || cmd === "!b") {
    try {
      const bakeries = await fetchTopBakeries();
      const ours = bakeries.find((b) => b.id === OUR_BAKERY_ID);
      if (!ours) {
        await message.channel.send("Couldn't find our bakery.");
        return;
      }

      const buffLines = ours.activeBuffs.map(
        (b) =>
          `⬆️ **${b.name}** · +${(b.multiplierBps / 100).toFixed(0)}% · expires <t:${b.endTime}:R>`,
      );
      const debuffLines = ours.activeDebuffs.map(
        (d) =>
          `🔻 **${d.name}** · -${(d.debuffBps / 100).toFixed(0)}% · expires <t:${d.endTime}:R>`,
      );

      const desc = [
        buffLines.length
          ? `**Buffs (${buffLines.length})**\n${buffLines.join("\n")}`
          : "**Buffs** — none",
        debuffLines.length
          ? `**Debuffs (${debuffLines.length})**\n${debuffLines.join("\n")}`
          : "**Debuffs** — none",
      ].join("\n\n");

      const embed = new EmbedBuilder()
        .setTitle("🍰 Cockring Cakehouse — Active Effects")
        .setDescription(desc)
        .setColor(0xf5a623)
        .setTimestamp();
      await message.channel.send({ embeds: [embed] });
    } catch {
      await message.channel.send("Failed to fetch buff data.");
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
