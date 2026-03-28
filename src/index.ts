import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  type TextChannel,
} from "discord.js";

const API_URL =
  "https://www.rugpullbakery.com/api/trpc/leaderboard.getTopBakeries?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22limit%22%3A15%7D%7D%7D";

const ONE_HOUR_MS = 60 * 60 * 1000;

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

function buildLeaderboardEmbed(bakeries: Bakery[]): EmbedBuilder {
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
    .setDescription(lines.join("\n\n") || "No data available.")
    .setColor(0xf5a623)
    .setFooter({ text: "rugpullbakery.com" })
    .setTimestamp();
}

async function postLeaderboard(channel: TextChannel): Promise<void> {
  try {
    const bakeries = await fetchTopBakeries();
    const embed = buildLeaderboardEmbed(bakeries);
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Failed to fetch leaderboard:", err);
    await channel.send("Failed to fetch the leaderboard. Try again later.");
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

    postScheduled();
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
