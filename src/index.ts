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
  activeBuffs: { name: string; multiplierBps: number }[];
  activeDebuffs: { name: string; debuffBps: number }[];
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
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = (await res.json()) as TrpcBatchResponse[];
  return data[0].result.data.json.items.slice(0, 5);
}

async function fetchSeasonInfo(): Promise<{ prizePoolStr: string; endTime: string }> {
  const [seasonRes, priceRes] = await Promise.all([
    fetch(SEASON_API_URL),
    fetch(ETH_PRICE_URL),
  ]);
  const seasonData = (await seasonRes.json()) as {
    result: { data: { json: { prizePool: string; endTime: string }[] } };
  }[];
  const priceData = (await priceRes.json()) as {
    ethereum: { usd: number };
  };
  const season = seasonData[0].result.data.json[0];
  const eth = Number(BigInt(season.prizePool)) / 1e18;
  const usd = eth * priceData.ethereum.usd;
  const prizePoolStr = `${eth.toFixed(2)} ETH ($${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })})`;
  return { prizePoolStr, endTime: season.endTime };
}

function buildLeaderboardEmbed(bakeries: Bakery[], prizePool: string, endTime: string): EmbedBuilder {
  const medals = ["🥇", "🥈", "🥉", "4.", "5."];

  const lines = bakeries.map((b, i) => {
    const medal = medals[i] ?? `${i + 1}.`;
    let rate = 1;
    for (const buff of b.activeBuffs) rate *= buff.multiplierBps / 10000;
    for (const debuff of b.activeDebuffs) rate *= 1 - debuff.debuffBps / 10000;
    const rateStr = rate.toFixed(2) + "x";
    const cookies = Math.round(Number(BigInt(b.txCount)) / 10000);
    const cookiesStr =
      cookies >= 1_000_000
        ? `${(cookies / 1e6).toFixed(2)}M`
        : cookies >= 1_000
          ? `${(cookies / 1e3).toFixed(1)}K`
          : String(cookies);
    return [
      `${medal} **${b.name}** — ${rateStr}`,
      `╰ 🍪 ${cookiesStr} · 👥 ${b.memberCount} · 🧑‍🍳 ${b.activeCookCount} · ⬆${b.activeBuffs.length} ⬇${b.activeDebuffs.length}`,
    ].join("\n");
  });

  return new EmbedBuilder()
    .setTitle("🍰 Top 5 Bakeries")
    .setDescription(`💰 Prize Pool: **${prizePool}**\n⏰ Season Ends: <t:${endTime}:R>\n\n${lines.join("\n\n") || "No data available."}`)
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
    await channel.send("Failed to fetch the leaderboard. Try again later.");
  }
}

async function resolveUsernames(addresses: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (addresses.length === 0) return map;
  const unique = [...new Set(addresses)];
  const encoded = encodeURIComponent(JSON.stringify({ "0": { json: { addresses: unique } } }));
  const url = `https://www.rugpullbakery.com/api/trpc/profiles.getByAddresses?batch=1&input=${encoded}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return map;
    const data = (await res.json()) as {
      result: { data: { json: { address: string; profile: { name: string } | null }[] } };
    }[];
    for (const entry of data[0].result.data.json) {
      const name = entry.profile?.name;
      if (name) map.set(entry.address, name);
    }
  } catch { /* fall back to truncated addresses */ }
  return map;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

let lastSeenTimestamp = "0";

async function pollActivityFeed(channel: TextChannel): Promise<void> {
  try {
    const res = await fetch(ACTIVITY_FEED_URL);
    if (!res.ok) return;
    const data = (await res.json()) as { result: { data: { json: FeedEvent[] } } }[];
    const events = data[0].result.data.json;

    const relevant = events
      .filter(
        (e) =>
          e.eventBakeryId === OUR_BAKERY_ID &&
          (e.type === "boost" || e.type === "rug") &&
          e.timestamp > lastSeenTimestamp
      )
      .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));

    const usernames = await resolveUsernames(relevant.map((e) => e.user));

    for (const e of relevant) {
      const icon = e.type === "boost" ? "⬆️" : "🔻";
      const status = e.success ? "✅" : "❌";
      const who = usernames.get(e.user) ?? shortAddr(e.user);
      const from = e.bakeryId !== OUR_BAKERY_ID ? ` (from **${e.bakeryName}**)` : "";
      const bps = e.boostMultiplierBps ? `${(e.boostMultiplierBps / 100).toFixed(0)}%` : "";
      const embed = new EmbedBuilder()
        .setDescription(
          `${icon} ${status} **${who}** ${e.event} ${e.eventBakeryName}${from}\n` +
          `${e.boostTypeName ?? "Unknown"} · ${bps} · <t:${e.timestamp}:R>`
        )
        .setColor(e.type === "boost" ? 0x2ecc71 : 0xe74c3c)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }

    if (relevant.length > 0) {
      lastSeenTimestamp = relevant[relevant.length - 1].timestamp;
    } else if (lastSeenTimestamp === "0" && events.length > 0) {
      lastSeenTimestamp = events[0].timestamp;
    }
  } catch (err) {
    console.error("Failed to poll activity feed:", err);
  }
}

client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);

  const channelId = process.env.CHANNEL_ID;
  if (channelId) {
    const postScheduled = async () => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased() && "send" in channel) {
        await postLeaderboard(channel as TextChannel);
      }
    };

    const startFeed = async () => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased() && "send" in channel) {
        // Set baseline so we don't replay old events on startup
        await pollActivityFeed(channel as TextChannel);
        setInterval(() => pollActivityFeed(channel as TextChannel), FEED_POLL_MS);
      }
    };

    postScheduled();
    startFeed();
    setInterval(postScheduled, ONE_HOUR_MS);
  } else {
    console.warn("CHANNEL_ID not set — scheduled posts disabled.");
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const cmd = message.content.trim().toLowerCase();
  if (cmd === "!lb") {
    await postLeaderboard(message.channel as TextChannel);
  } else if (cmd === "!join") {
    await message.channel.send("https://x.com/Skarly/status/2037208078144463181");
  } else if (cmd === "!git") {
    await message.channel.send("https://github.com/skarlywarly/cockring-cakehouse");
  }
});

client.login(process.env.DISCORD_TOKEN);
