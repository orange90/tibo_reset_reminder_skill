import { TARGET_USERNAME } from "./config.js";

const REQUEST_TIMEOUT_MS = 12_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();
}

function htmlEntityDecode(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(/&#([0-9]+);/g, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 10)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(
    /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    result[match[1].toLowerCase()] = htmlEntityDecode(match[2] ?? match[3]);
  }
  return result;
}

function findObjectRecord(source, key) {
  if (!key) {
    return null;
  }
  const candidates = [String(key)];
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    const unpadded = key.replace(/=+$/, "");
    candidates.push(unpadded, unpadded + "=", unpadded + "==");
  }

  let markerIndex = -1;
  let markerLength = 0;
  for (const candidate of new Set(candidates)) {
    const markers = [JSON.stringify(candidate) + ":"];
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(candidate)) {
      markers.push(candidate + ":");
    }
    for (const marker of markers) {
      markerIndex = source.indexOf(marker);
      if (markerIndex >= 0) {
        markerLength = marker.length;
        break;
      }
    }
    if (markerIndex >= 0) {
      break;
    }
  }
  if (markerIndex < 0) {
    return null;
  }
  const assignmentIndex = source.indexOf("={", markerIndex + markerLength);
  if (assignmentIndex < 0) {
    return null;
  }

  const start = assignmentIndex + 1;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return null;
}

function fieldPosition(record, field) {
  const match = new RegExp("(?:^|[,{])" + field + ":").exec(record);
  if (!match) {
    return -1;
  }
  return match.index + match[0].length;
}

function readQuotedString(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      const token = source.slice(start, index + 1);
      if (quote === '"') {
        try {
          return JSON.parse(token);
        } catch {
          return null;
        }
      }
      return token
        .slice(1, -1)
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\");
    }
  }
  return null;
}

function stringField(record, field) {
  const start = fieldPosition(record, field);
  return start < 0 ? null : readQuotedString(record, start);
}

function numberField(record, field) {
  const start = fieldPosition(record, field);
  if (start < 0) {
    return null;
  }
  const match = /^(\d+)/.exec(record.slice(start));
  return match ? Number(match[1]) : null;
}

function refField(record, field) {
  const start = fieldPosition(record, field);
  if (start < 0) {
    return null;
  }
  const match = /^\$R\[\d+\]=\{__ref:("(?:\\.|[^"\\])*")\}/.exec(
    record.slice(start),
  );
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function nonNullField(record, field) {
  const start = fieldPosition(record, field);
  if (start < 0) {
    return false;
  }
  const value = record.slice(start);
  return !/^(?:null|undefined|void\s+0)(?:[,}])/.test(value);
}

function snowflakeCreatedAt(id) {
  try {
    const milliseconds = (BigInt(id) >> 22n) + 1288834974657n;
    const date = new Date(Number(milliseconds));
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function relayUsername(source, tweetRecord) {
  const tweetCore = findObjectRecord(source, refField(tweetRecord, "core"));
  const userResults = tweetCore
    ? findObjectRecord(source, refField(tweetCore, "user_results"))
    : null;
  const user = userResults
    ? findObjectRecord(source, refField(userResults, "result"))
    : null;
  const userCore = user
    ? findObjectRecord(source, refField(user, "core"))
    : null;
  return userCore ? stringField(userCore, "screen_name") : null;
}

function relayNoteText(source, tweetRecord) {
  const noteData = findObjectRecord(source, refField(tweetRecord, "note_tweet"));
  const noteResults = noteData
    ? findObjectRecord(source, refField(noteData, "note_tweet_results"))
    : null;
  const note = noteResults
    ? findObjectRecord(source, refField(noteResults, "result"))
    : null;
  return note ? stringField(note, "text") : null;
}

function parseRelayProfileHtml(html, expectedUsername) {
  const source = String(html);
  const entryIds = new Set();
  for (const match of source.matchAll(/entry_id:"tweet-(\d+)"/g)) {
    entryIds.add(match[1]);
  }
  if (!entryIds.size) {
    return [];
  }

  const posts = [];
  for (const id of entryIds) {
    const tweetKey = Buffer.from("Tweet:" + id).toString("base64");
    const tweetRecord = findObjectRecord(source, tweetKey);
    if (
      !tweetRecord ||
      normalizeUsername(relayUsername(source, tweetRecord)) !==
        normalizeUsername(expectedUsername)
    ) {
      continue;
    }

    const legacy = findObjectRecord(source, refField(tweetRecord, "legacy"));
    if (legacy && nonNullField(legacy, "retweeted_status_results")) {
      continue;
    }
    const details = findObjectRecord(source, refField(tweetRecord, "details"));
    const text =
      relayNoteText(source, tweetRecord) ||
      (details ? stringField(details, "full_text") : null);
    const createdAtMilliseconds = details
      ? numberField(details, "created_at_ms")
      : null;
    const createdAt = createdAtMilliseconds
      ? new Date(createdAtMilliseconds).toISOString()
      : snowflakeCreatedAt(id);
    if (!text || !createdAt) {
      continue;
    }

    const kind = nonNullField(tweetRecord, "reply_to_results")
      ? "reply"
      : nonNullField(tweetRecord, "quoted_tweet_results")
        ? "quote"
        : "post";
    posts.push({
      id,
      text: htmlEntityDecode(text),
      created_at: createdAt,
      url: "https://x.com/" + expectedUsername + "/status/" + id,
      kind,
    });
  }
  return posts;
}

export function parsePublicProfileHtml(
  html,
  expectedUsername = TARGET_USERNAME,
) {
  const posts = new Map();
  for (const match of String(html).matchAll(
    /<article\b[^>]*data-tweet-id=["'](\d+)["'][^>]*>([\s\S]*?)<\/article>/gi,
  )) {
    const id = match[1];
    const body = match[2];
    const metadata = {};
    for (const tagMatch of body.matchAll(/<meta\b[^>]*>/gi)) {
      const values = attributes(tagMatch[0]);
      const key = String(values.itemprop || "").toLowerCase();
      if (key && values.content !== undefined && metadata[key] === undefined) {
        metadata[key] = values.content;
      }
    }
    if (
      normalizeUsername(metadata.alternatename) !==
      normalizeUsername(expectedUsername)
    ) {
      continue;
    }
    const text = metadata.articlebody || metadata.text || metadata.headline;
    const createdAt = metadata.datepublished || metadata.datecreated;
    if (!text || !createdAt || Number.isNaN(Date.parse(createdAt))) {
      continue;
    }
    posts.set(id, {
      id,
      text,
      created_at: new Date(createdAt).toISOString(),
      url: "https://x.com/" + expectedUsername + "/status/" + id,
      kind: "post",
    });
  }
  for (const post of parseRelayProfileHtml(html, expectedUsername)) {
    posts.set(post.id, post);
  }
  const normalized = [...posts.values()].sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  );
  if (!normalized.length) {
    throw new Error(
      "X public profile returned no verified posts for @" + expectedUsername,
    );
  }
  return normalized;
}

function findNextData(html) {
  const patterns = [
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]*type=["']application\/json["'][^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  throw new Error("X public Embed response did not contain timeline data");
}

function getPath(object, path) {
  let value = object;
  for (const part of path) {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    value = value[part];
  }
  return value;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim());
}

function tweetCandidate(object, expectedUsername) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    return null;
  }

  const legacy =
    object.legacy && typeof object.legacy === "object" ? object.legacy : object;
  const id = firstString(object.rest_id, object.id_str, legacy.id_str);
  const text = firstString(
    getPath(object, ["note_tweet", "note_tweet_results", "result", "text"]),
    getPath(object, ["note_tweet_results", "result", "text"]),
    object.full_text,
    legacy.full_text,
    object.text,
    legacy.text,
  );
  const username = firstString(
    getPath(object, [
      "core",
      "user_results",
      "result",
      "legacy",
      "screen_name",
    ]),
    getPath(object, ["core", "user_results", "result", "core", "screen_name"]),
    getPath(object, ["user", "legacy", "screen_name"]),
    getPath(object, ["user", "screen_name"]),
    getPath(object, ["author", "username"]),
  );

  if (
    !id ||
    !/^\d{5,}$/.test(id) ||
    !text ||
    normalizeUsername(username) !== normalizeUsername(expectedUsername)
  ) {
    return null;
  }

  if (
    legacy.retweeted_status_result ||
    legacy.retweeted_status_id_str ||
    object.retweeted_status
  ) {
    return null;
  }

  const rawCreatedAt = firstString(object.created_at, legacy.created_at);
  const parsedCreatedAt = rawCreatedAt ? new Date(rawCreatedAt) : null;
  const createdAt =
    parsedCreatedAt && !Number.isNaN(parsedCreatedAt.valueOf())
      ? parsedCreatedAt.toISOString()
      : null;
  const kind = legacy.in_reply_to_status_id_str
    ? "reply"
    : legacy.quoted_status_id_str || object.quoted_status_result
      ? "quote"
      : "post";

  return {
    id,
    text: htmlEntityDecode(text),
    created_at: createdAt,
    url: "https://x.com/" + expectedUsername + "/status/" + id,
    kind,
  };
}

export function parseSyndicationHtml(
  html,
  expectedUsername = TARGET_USERNAME,
) {
  let data;
  const source = findNextData(html);
  try {
    data = JSON.parse(source);
  } catch (error) {
    throw new Error("X public Embed timeline data was not valid JSON", {
      cause: error,
    });
  }

  const found = new Map();
  const seen = new Set();
  const stack = [data];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const candidate = tweetCandidate(value, expectedUsername);
    if (candidate && !found.has(candidate.id)) {
      found.set(candidate.id, candidate);
    }
    if (Array.isArray(value)) {
      stack.push(...value);
    } else {
      stack.push(...Object.values(value));
    }
  }

  const posts = [...found.values()].sort((left, right) => {
    if (left.created_at && right.created_at) {
      return right.created_at.localeCompare(left.created_at);
    }
    try {
      return Number(BigInt(right.id) - BigInt(left.id));
    } catch {
      return right.id.localeCompare(left.id);
    }
  });
  if (!posts.length) {
    throw new Error("X public Embed returned no verified posts for @" + expectedUsername);
  }
  return posts;
}

function timelineUrl(username) {
  const base =
    "https://syndication.twitter.com/srv/timeline-profile/screen-name/" +
    encodeURIComponent(username);
  const params = new URLSearchParams({
    dnt: "true",
    frame: "false",
    hideBorder: "true",
    hideFooter: "true",
    hideHeader: "true",
    hideScrollBar: "true",
    lang: "en",
    showReplies: "true",
    transparent: "true",
  });
  return base + "?" + params.toString();
}

async function fetchOnce(username) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(timelineUrl(username), {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
        "user-agent":
          "Mozilla/5.0 (compatible; tibo-reset-reminder-feed/1.0; +https://github.com/orange90/tibo_reset_reminder_skill)",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(
        "X public Embed returned HTTP " + response.status,
      );
      error.status = response.status;
      throw error;
    }
    return await response.text();
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("X public Embed request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProfileOnce(username) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      "https://x.com/" + encodeURIComponent(username),
      {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
          "user-agent":
            "Mozilla/5.0 (compatible; tibo-reset-reminder-feed/1.0; +https://github.com/orange90/tibo_reset_reminder_skill)",
        },
        redirect: "follow",
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const error = new Error(
        "X public profile returned HTTP " + response.status,
      );
      error.status = response.status;
      throw error;
    }
    return await response.text();
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("X public profile request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichLongPosts(posts, username) {
  const candidates = posts.filter((post) => post.text.length >= 250).slice(0, 4);
  if (!candidates.length) {
    return posts;
  }
  const replacements = new Map();
  const results = await Promise.allSettled(
    candidates.map(async (post) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(post.url, {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9",
            "user-agent":
              "Mozilla/5.0 (compatible; tibo-reset-reminder-feed/1.0; +https://github.com/orange90/tibo_reset_reminder_skill)",
          },
          redirect: "follow",
          signal: controller.signal,
        });
        if (!response.ok) {
          return;
        }
        const pagePosts = parsePublicProfileHtml(await response.text(), username);
        const expanded = pagePosts.find((item) => item.id === post.id);
        if (expanded && expanded.text.length > post.text.length) {
          replacements.set(post.id, expanded);
        }
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  void results;
  return posts.map((post) => replacements.get(post.id) || post);
}

export async function fetchPublicTimeline(username = TARGET_USERNAME) {
  let profileError;
  try {
    const profileHtml = await fetchProfileOnce(username);
    const profilePosts = await enrichLongPosts(
      parsePublicProfileHtml(profileHtml, username),
      username,
    );
    try {
      const embedHtml = await fetchOnce(username);
      const embedPosts = parseSyndicationHtml(embedHtml, username);
      const merged = new Map(
        [...embedPosts, ...profilePosts].map((post) => [post.id, post]),
      );
      return [...merged.values()].sort((left, right) =>
        String(right.created_at || "").localeCompare(
          String(left.created_at || ""),
        ),
      );
    } catch {
      return profilePosts;
    }
  } catch (error) {
    profileError = error;
  }

  let embedError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const html = await fetchOnce(username);
      return parseSyndicationHtml(html, username);
    } catch (error) {
      embedError = error;
      if (
        attempt === 1 ||
        (error.status && !RETRYABLE_STATUS.has(error.status))
      ) {
        break;
      }
      await sleep(500);
    }
  }
  throw new Error(
    "X public sources failed: " +
      profileError.message +
      "; " +
      embedError.message,
  );
}
