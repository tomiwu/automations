import type { Language } from "./config.ts";

const en = {
  "morning.title": "Morning report",
  "morning.heading": "Morning report for {child}, {date}",
  "morning.lessons": "Lessons today:",
  "morning.lesson": "{time} {subject}",
  "morning.no_lessons": "No lessons today.",
  "morning.upcoming": "Coming up:",
  "afterschool.title": "After school",
  "afterschool.item": "{time} {name} ({place})",
  "afterschool.none": "No activities after school today.",
  "grade.new": "New grade for {child}: {subject}, {value}",
  "message.new": "New message for {child}: {subject}",
  "announcement.new": "New announcement for {child}: {subject}",
  "homework.new": "New homework for {child}: {subject}, due {date}",
  "test.upcoming": "Test for {child}: {subject}, {date}",
  "activity.cancelled": "Activity cancelled for {child}: {name}, {date}",
  "activity.changed": "Activity changed for {child}: {name}, {date}",
  "error.login": "Login failed for {child}. Check the account.",
  "error.fetch": "Data fetch failed for {child}: {reason}",
} as const;

export type MessageKey = keyof typeof en;
export type Catalog = Record<MessageKey, string>;

const pl: Catalog = {
  "morning.title": "Raport poranny",
  "morning.heading": "Raport poranny dla {child}, {date}",
  "morning.lessons": "Dzisiejsze lekcje:",
  "morning.lesson": "{time} {subject}",
  "morning.no_lessons": "Dzisiaj nie ma lekcji.",
  "morning.upcoming": "Wkrótce:",
  "afterschool.title": "Po szkole",
  "afterschool.item": "{time} {name} ({place})",
  "afterschool.none": "Dzisiaj nie ma zajęć po szkole.",
  "grade.new": "Nowa ocena dla {child}: {subject}, {value}",
  "message.new": "Nowa wiadomość dla {child}: {subject}",
  "announcement.new": "Nowe ogłoszenie dla {child}: {subject}",
  "homework.new": "Nowa praca domowa dla {child}: {subject}, termin {date}",
  "test.upcoming": "Sprawdzian dla {child}: {subject}, {date}",
  "activity.cancelled": "Zajęcia odwołane dla {child}: {name}, {date}",
  "activity.changed": "Zmiana zajęć dla {child}: {name}, {date}",
  "error.login": "Logowanie nie powiodło się dla {child}. Sprawdź konto.",
  "error.fetch": "Pobieranie danych nie powiodło się dla {child}: {reason}",
};

export const CATALOGS: Record<Language, Catalog> = { pl, en };

export type MessageParams = Record<string, string | number>;

export function t(language: Language, key: MessageKey, params: MessageParams = {}): string {
  return CATALOGS[language][key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}
