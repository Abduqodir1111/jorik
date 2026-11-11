import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import bigInt from "big-integer";
import { Api } from "teleproto";
import { yandexLocationUrl } from "../shared/location.js";
import LocationCard from "../src/LocationCard.js";
import { richMedia } from "../server/telegram-rich-media.js";
import { instagramAttachments } from "../server/instagram-media.js";

test("Location link centers and selects the exact point, opening its address card instead of a bare map", () => {
  const link = new URL(yandexLocationUrl(41.3111, 69.2797)!);
  assert.equal(link.origin, "https://yandex.ru");
  assert.equal(link.pathname, "/maps/");
  assert.equal(link.searchParams.get("ll"), "69.2797,41.3111");
  assert.equal(link.searchParams.get("whatshere[point]"), "69.2797,41.3111");
  assert.equal(link.searchParams.get("mode"), "whatshere");
  assert.equal(link.searchParams.get("z"), "17");
  assert.equal(
    link.searchParams.get("text"),
    null,
    "A text search must not move the pin to another place",
  );
  assert.equal(
    new URL(yandexLocationUrl(-33.86, 151.2)!).searchParams.get(
      "whatshere[point]",
    ),
    "151.2,-33.86",
  );
});

test("Location card keeps valid zero coordinates and rejects missing, invalid and out-of-range coordinates", () => {
  assert.ok(yandexLocationUrl(0, 0));
  for (const [lat, lon] of [
    [undefined, 69],
    [41, undefined],
    [NaN, 69],
    [41, Infinity],
    [91, 69],
    [41, -181],
    ["41", 69],
  ]) {
    assert.equal(yandexLocationUrl(lat, lon), null);
    const html = renderToStaticMarkup(
      createElement(LocationCard, {
        attachment: {
          kind: "location",
          latitude: lat as number,
          longitude: lon as number,
          name: "Location",
          url: "",
          mime: "application/geo+json",
          size: 0,
        },
      }),
    );
    assert.ok(!html.includes("href="));
    assert.match(html, /Геолокация недоступна/);
  }
});

test("Telegram venue address and Instagram location address survive normalization and are visible beside the map link", () => {
  const message = new Api.Message({
    id: 1,
    peerId: new Api.PeerUser({ userId: bigInt(123) }),
    date: 1,
    message: "",
  });
  message.media = new Api.MessageMediaVenue({
    geo: new Api.GeoPoint({
      lat: 41.3111,
      long: 69.2797,
      accessHash: bigInt(0),
    }),
    title: "Сквер",
    address: "  Ташкент, сквер Амира Темура  ",
    provider: "",
    venueId: "",
    venueType: "",
  });
  const telegram = richMedia(message)!;
  assert.equal(telegram.address, "Ташкент, сквер Амира Темура");
  const instagram = instagramAttachments(
    [
      {
        location_data: {
          latitude: 41.3111,
          longitude: 69.2797,
          name: "Сквер",
          address: telegram.address,
        },
      },
    ],
    "synthetic",
  )[0];
  assert.equal(instagram.address, telegram.address);
  for (const attachment of [telegram, instagram]) {
    const html = renderToStaticMarkup(
      createElement(LocationCard, { attachment }),
    );
    assert.match(html, /Ташкент, сквер Амира Темура/);
    const href = html.match(/href="([^"]+)"/)![1].replaceAll("&amp;", "&");
    assert.equal(
      new URL(href).searchParams.get("whatshere[point]"),
      "69.2797,41.3111",
    );
    assert.match(html, /noopener noreferrer/);
  }
  const oldLocation = { ...telegram };
  delete oldLocation.address;
  assert.match(
    renderToStaticMarkup(
      createElement(LocationCard, { attachment: oldLocation }),
    ),
    /whatshere/,
  );
});
