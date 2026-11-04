const clock = new Intl.DateTimeFormat("ru", {
  hour: "2-digit",
  minute: "2-digit",
});
const calendar = new Intl.DateTimeFormat("ru", {
  day: "numeric",
  month: "long",
});
export const time = (value: string) => clock.format(new Date(value));
export const date = (value: string) => calendar.format(new Date(value));
