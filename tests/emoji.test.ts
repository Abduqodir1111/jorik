import test from "node:test";
import assert from "node:assert/strict";
import {
  allEmoji,
  emojiCategories,
  filterEmoji,
  insertEmoji,
} from "../src/emoji-data.js";

test("Emoji insertion preserves surrounding text and replaces only the selected UTF-16 range", () => {
  assert.deepEqual(insertEmoji("", 0, 0, "😊"), { text: "😊", caret: 2 });
  assert.deepEqual(insertEmoji("Привет, мир", 8, 8, "📚"), {
    text: "Привет, 📚мир",
    caret: 10,
  });
  assert.deepEqual(insertEmoji("Привет🙂мир", 6, 8, "🇺🇿"), {
    text: "Привет🇺🇿мир",
    caret: 10,
  });
  const first = insertEmoji("Доставка", 8, 8, "👨‍👩‍👧‍👦");
  const next = insertEmoji(first.text, first.caret, first.caret, "👍🏽");
  assert.equal(next.text, "Доставка👨‍👩‍👧‍👦👍🏽");
  assert.equal(next.caret, next.text.length);
  assert.deepEqual(insertEmoji("abc", -1, 99, "❤️"), { text: "❤️", caret: 2 });
});

test("Emoji search finds Russian names, English aliases and Unicode emoji across categories", () => {
  assert.ok(filterEmoji("книги").some((item) => item.emoji === "📚"));
  assert.ok(filterEmoji("СПАСИБО").some((item) => item.emoji === "🙏"));
  assert.ok(filterEmoji("зелёное сердце").some((item) => item.emoji === "💚"));
  assert.ok(filterEmoji("happy").some((item) => item.emoji === "😀"));
  assert.ok(filterEmoji("👩‍💻").some((item) => item.emoji === "👩‍💻"));
  assert.deepEqual(filterEmoji("неизвестныйэмодзи"), []);
});

test("Every emoji category has unique stable buttons and all values are plain Unicode text", () => {
  assert.equal(new Set(allEmoji.map((e) => e.emoji)).size, allEmoji.length);
  for (const category of emojiCategories) {
    assert.equal(
      new Set(category.items.map(([emoji]) => emoji)).size,
      category.items.length,
    );
    assert.ok(
      category.items.every(
        ([emoji, label]) =>
          emoji.length > 0 && label.length > 0 && !emoji.includes("<"),
      ),
    );
  }
});
