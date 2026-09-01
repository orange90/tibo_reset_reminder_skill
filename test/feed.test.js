import assert from "node:assert/strict";
import test from "node:test";

import { mergeFeed } from "../lib/feed.js";
import {
  parsePublicProfileHtml,
  parseSyndicationHtml,
} from "../lib/syndication.js";

function fixture(payload) {
  return (
    '<!doctype html><script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify(payload) +
    "</script>"
  );
}

function relayTweet({
  id,
  username,
  text,
  createdAt,
  quote = false,
  reply = false,
  retweet = false,
  noteText = null,
  offset = 0,
}) {
  const tweetKey = Buffer.from("Tweet:" + id).toString("base64");
  const userKey = Buffer.from("User:" + username + ":1").toString("base64");
  const userReferenceKey = userKey.replace(/=+$/, "");
  const userResultsKey = Buffer.from("UserResults:" + username).toString(
    "base64",
  );
  const noteResultsKey = Buffer.from("NoteTweetResults:" + id).toString(
    "base64",
  );
  const noteKey = Buffer.from("NoteTweet:" + id).toString("base64");
  const index = 100 + offset * 30;
  const reference = (value, at) =>
    `$R[${at}]={__ref:${JSON.stringify(value)}}`;

  const records = [
    `"entry:${id}":$R[${index}]={entry_id:"tweet-${id}"}`,
    `"${tweetKey}":$R[${index + 1}]={` +
      `__typename:"Tweet",rest_id:"${id}",` +
      `core:${reference(`client:${tweetKey}:core`, index + 2)},` +
      `details:${reference(`client:${tweetKey}:details`, index + 3)},` +
      `note_tweet:${
        noteText
          ? reference(`client:${tweetKey}:note_tweet`, index + 4)
          : "null"
      },` +
      `reply_to_results:${
        reply ? reference("TweetResults:parent", index + 5) : "null"
      },` +
      `quoted_tweet_results:${
        quote ? reference("TweetResults:quoted", index + 6) : "null"
      },` +
      `legacy:${reference(`client:${tweetKey}:legacy`, index + 7)}}`,
    `"client:${tweetKey}:core":$R[${index + 8}]={` +
      `user_results:${reference(userResultsKey, index + 9)}}`,
    `"${userResultsKey}":$R[${index + 10}]={` +
      `result:${reference(userReferenceKey, index + 11)}}`,
    `${userReferenceKey}:$R[${index + 12}]={` +
      `core:${reference(`client:${userReferenceKey}:core`, index + 13)}}`,
    `"client:${userReferenceKey}:core":$R[${index + 14}]={` +
      `screen_name:${JSON.stringify(username)}}`,
    `"client:${tweetKey}:details":$R[${index + 15}]={` +
      `__typename:"TBirdData",full_text:${JSON.stringify(text)},` +
      `created_at_ms:${Date.parse(createdAt)}}`,
    `"client:${tweetKey}:legacy":$R[${index + 16}]={` +
      `retweeted_status_results:${
        retweet ? reference("TweetResults:repost", index + 17) : "null"
      }}`,
  ];
  if (noteText) {
    records.push(
      `"client:${tweetKey}:note_tweet":$R[${index + 18}]={` +
        `note_tweet_results:${reference(noteResultsKey, index + 19)}}`,
      `"${noteResultsKey}":$R[${index + 20}]={` +
        `result:${reference(noteKey, index + 21)}}`,
      `"${noteKey}":$R[${index + 22}]={` +
        `__typename:"NoteTweet",text:${JSON.stringify(noteText)}}`,
    );
  }
  return records.join(",");
}

function relayFixture(posts) {
  return `<script>(${posts.map(relayTweet).join(",")})</script>`;
}

test("parses verified target posts and excludes reposts and quoted authors", () => {
  const payload = {
    pageProps: {
      timeline: [
        {
          rest_id: "1900000000000000001",
          core: {
            user_results: { result: { legacy: { screen_name: "thsottiaux" } } },
          },
          legacy: {
            full_text: "Codex limits reset in two hours &amp; then weekly.",
            created_at: "Tue Jul 29 08:00:00 +0000 2026",
            quoted_status_id_str: "1800000000000000000",
          },
        },
        {
          rest_id: "1900000000000000002",
          core: {
            user_results: { result: { legacy: { screen_name: "someone_else" } } },
          },
          legacy: {
            full_text: "A quoted post",
            created_at: "Tue Jul 29 07:00:00 +0000 2026",
          },
        },
        {
          rest_id: "1900000000000000003",
          core: {
            user_results: { result: { legacy: { screen_name: "thsottiaux" } } },
          },
          legacy: {
            full_text: "Plain repost",
            created_at: "Tue Jul 29 06:00:00 +0000 2026",
            retweeted_status_id_str: "1700000000000000000",
          },
        },
      ],
    },
  };
  assert.deepEqual(parseSyndicationHtml(fixture(payload)), [
    {
      id: "1900000000000000001",
      text: "Codex limits reset in two hours & then weekly.",
      created_at: "2026-07-29T08:00:00.000Z",
      url: "https://x.com/thsottiaux/status/1900000000000000001",
      kind: "quote",
    },
  ]);
});

test("parses semantic metadata from the public X profile", () => {
  const html =
    '<article data-tweet-id="1900000000000000004">' +
    '<meta content="2026-07-29T10:00:00.000Z" itemProp="datePublished"/>' +
    '<meta content="Limits reset &amp; Codex is back. It&#x27;s live." itemProp="articleBody"/>' +
    '<meta content="thsottiaux" itemProp="alternateName"/>' +
    "</article>" +
    '<article data-tweet-id="1900000000000000005">' +
    '<meta content="2026-07-29T09:00:00.000Z" itemProp="datePublished"/>' +
    '<meta content="Quoted text" itemProp="articleBody"/>' +
    '<meta content="someone_else" itemProp="alternateName"/>' +
    "</article>";
  assert.deepEqual(parsePublicProfileHtml(html), [
    {
      id: "1900000000000000004",
      text: "Limits reset & Codex is back. It's live.",
      created_at: "2026-07-29T10:00:00.000Z",
      url: "https://x.com/thsottiaux/status/1900000000000000004",
      kind: "post",
    },
  ]);
});

test("parses the current public X Relay stream without evaluating scripts", () => {
  const html = relayFixture([
    {
      id: "1900000000000000101",
      username: "thsottiaux",
      text: "Short preview",
      noteText: "Codex weekly allowance may reset tomorrow.",
      createdAt: "2026-07-29T12:00:00.000Z",
      quote: true,
      offset: 0,
    },
    {
      id: "1900000000000000102",
      username: "someone_else",
      text: "Quoted author text must not leak into the profile feed.",
      createdAt: "2026-07-29T11:00:00.000Z",
      offset: 1,
    },
    {
      id: "1900000000000000103",
      username: "thsottiaux",
      text: "A plain repost",
      createdAt: "2026-07-29T10:00:00.000Z",
      retweet: true,
      offset: 2,
    },
  ]);
  assert.deepEqual(parsePublicProfileHtml(html), [
    {
      id: "1900000000000000101",
      text: "Codex weekly allowance may reset tomorrow.",
      created_at: "2026-07-29T12:00:00.000Z",
      url: "https://x.com/thsottiaux/status/1900000000000000101",
      kind: "quote",
    },
  ]);
});

test("merges edited posts, reports additions, and preserves history", () => {
  const previous = {
    posts: [
      {
        id: "1900000000000000001",
        text: "Old wording",
        created_at: "2026-07-29T08:00:00.000Z",
      },
    ],
  };
  const incoming = [
    {
      id: "1900000000000000001",
      text: "Edited wording",
      created_at: "2026-07-29T08:00:00.000Z",
    },
    {
      id: "1900000000000000002",
      text: "New post",
      created_at: "2026-07-29T09:00:00.000Z",
    },
  ];
  const result = mergeFeed(previous, incoming, new Date("2026-07-29T10:00:00Z"));
  assert.deepEqual(result.added, ["1900000000000000002"]);
  assert.deepEqual(result.updated, ["1900000000000000001"]);
  assert.deepEqual(
    result.feed.posts.map((post) => post.text),
    ["New post", "Edited wording"],
  );
  assert.equal(result.feed.stale, false);
});
