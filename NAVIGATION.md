# Снимки: выбор треков и сортировка

Все команды `snapshot` только читают медиатеку. Без пути к JSON — лёгкий просмотр в консоли, с путём — редактируемый запрос для `prepare`. Теги, избранное и порядок треков в Music не меняются.

## Быстро посмотреть или сохранить

```sh
./music-tags snapshot --artist '1.kla$ OR Czar'
./music-tags snapshot --artist '1.kla$ OR Czar' --show all
./music-tags snapshot --artist '1.kla$ OR Czar' runs/klass-czar-v1.json
```

В консоли: количество треков, общая длительность, число избранных; затем артист, название, длительность, альбом, год и `fav:+/-/?`. По умолчанию первые 20 строк; `--show N` задаёт число строк, `--show all` показывает все, `--show 0` оставляет сводку. Выборка и экспорт всегда полные. Без файла аудиозаписи, обложки и тексты не читаются; хеши не считаются. `snapshot` без аргументов показывает всю медиатеку, `snapshot French` — плейлист. Для названия плейлиста с окончанием `.json` используй `--playlist` явно.

## Простые фильтры

```sh
./music-tags snapshot --help
./music-tags snapshot --artist Bushido runs/bushido-v1.json
./music-tags snapshot --genre "German Hip-Hop" --artist 'Bushido OR Fler' runs/bushido-fler-v1.json
./music-tags snapshot --genre "German Hip-Hop" --artist 'Bushido NOT Fler' runs/bushido-without-fler-v1.json
./music-tags snapshot --name "remix" runs/remixes-v1.json
./music-tags snapshot --album "Carlo Cokxxx" runs/album-v1.json
./music-tags snapshot --genre "German Hip-Hop" --favorite true runs/favorites-v1.json
./music-tags snapshot --min-duration 3:00 --max-duration 10:00 --sort duration --desc runs/long-v1.json
./music-tags snapshot --playlist French --artist Leto --sort name runs/french-leto-v1.json
```

Флаги можно сочетать: **разные флаги соединяются через И**. Внутри текстового аргумента доступны И/ИЛИ/НЕ. Без плейлиста поиск идёт по всей медиатеке. Старые формы `snapshot "French" output.json`, `snapshot --all output.json` и `snapshot --genre "German Hip-Hop" output.json` работают.

| Флаг | Условие |
|---|---|
| `--name`, `--title` | Название содержит текст |
| `--artist` | Поле исполнителя содержит текст; подходит и для совместных треков |
| `--album` | Альбом содержит текст |
| `--album-artist` | Исполнитель альбома содержит текст |
| `--genre` | Жанр точно совпадает |
| `--favorite true` / `false` | Трек избранный / не избранный в Music |
| `--min-duration`, `--max-duration` | Длительность от/до, включая границы |
| `--sort` | Порядок записей в снимке: `name`, `artist`, `album`, `albumArtist`, `genre`, `favorite`, `duration` |
| `--desc` | Обратный порядок; используется с `--sort` |
| `--show N` / `all` | Ограничить только вывод в консоль; по умолчанию 20 строк |

Длительность: секунды (`180`, `180.5`), `M:SS` (`3:00`) или `H:MM:SS` (`1:02:03`). Ноль допустим, отрицательные значения и диапазон «от 300 до 100» отклоняются. В снимке длительность остаётся числом секунд.

Текст сопоставляется без учёта регистра, крайних/повторных пробелов и канонических Unicode-вариантов. `$` и точки — обычные символы, регулярные выражения не выполняются. В командной строке значения с пробелами/`$` заключай в одинарные кавычки: `--artist '1.kla$'`.

## Логика прямо в консоли

Выражение целиком передаётся **одним аргументом в кавычках**:

```sh
./music-tags snapshot --artist 'Bushido OR Fler' runs/or-v1.json
./music-tags snapshot --artist 'Bushido || Fler' runs/or-symbol-v1.json
./music-tags snapshot --artist 'Bushido AND Fler' runs/collaborations-v1.json
./music-tags snapshot --artist 'Bushido NOT Fler' runs/without-fler-v1.json
./music-tags snapshot --artist 'Bushido AND NOT Fler' runs/without-fler-v2.json
./music-tags snapshot --artist '(Bushido OR Fler) AND NOT Sido' runs/group-v1.json
./music-tags snapshot --artist '1.kla$ OR Czar' runs/klass-czar-v1.json
```

| Условие | Какие записи проходят по полю artist |
|---|---|
| `Bushido OR Fler` / `Bushido || Fler` | Есть любое из двух имён: сольные и совместные записи |
| `Bushido AND Fler` / `Bushido && Fler` | Встречаются оба имени |
| `Bushido AND NOT Fler` / `Bushido NOT Fler` / `Bushido && !Fler` | Есть Bushido, нет Fler; другие участники допустимы |
| `NOT (Bushido OR Fler)` | Нет ни Bushido, ни Fler |

Приоритет: **NOT → AND → OR**. Скобки меняют группировку. `Bushido OR Fler AND NOT Sido` означает `Bushido OR (Fler AND NOT Sido)`; чтобы исключить Sido из обеих групп, напиши `(Bushido OR Fler) AND NOT Sido`.

Слова-операторы распознаются только ЗАГЛАВНЫМИ: `AND`, `OR`, `NOT`. Обычные `Or Noir`, `Not Afraid`, `Me And You` сохраняют значение буквального поиска. Если само название содержит оператор заглавными, заключи название во внутренние двойные кавычки. Внутренние кавычки также позволяют искать скобки как часть сложного имени:

```sh
./music-tags snapshot --name '"LOVE AND WAR" OR "NOT TODAY"' runs/titles-v1.json
./music-tags snapshot --artist '"AK Ausserkontrolle" OR Fler' runs/artists-v1.json
./music-tags snapshot --name '"Song (Remix)" AND NOT Live' runs/versions-v1.json
```

Выражения доступны в `--name` / `--title`, `--artist`, `--album`, `--album-artist`, `--genre`. Для жанра каждый термин сопоставляется точно, для остальных текстовых флагов — по содержимому поля. Если выражение без операторов, обычные скобки и апострофы остаются буквальными: `--name 'Song (Part II)'` и `--name "I'm Not Afraid"`.

**Не ставь `||` или `&&` между аргументами без общих кавычек:** это операторы самой оболочки. Например, `--artist "Bushido" || "Fler"` не является фильтром: оболочка запускает другую команду. Используй `--artist 'Bushido || Fler'`. После `\` для переноса команды не должно быть пробелов или комментариев.

Это поиск по тексту тега: если участник фита указан только в названии, фильтр `--artist` его не обнаружит. Для исключения Fler также из названия можно добавить `--name 'NOT Fler'`.

## Результат и ограничения

В JSON сохраняется запрос версии 1: `tracks[].id`, `expect`, текущие метаданные в `set`, пустой `fill`, места под `artwork_file` и `lyrics_file`. Пропуски — `null`, что означает «оставить без изменений». `set.lyrics` всегда `null`; наличие текста видно в `info.lyrics_present`. Значения `set` — явные целевые значения, которые при `prepare` сравниваются с актуальной музыкой. Их можно исправить, удалить или заменить на `null`. Пример — `examples/snapshot.json`.

В `info` хранятся длительность, избранное (`true`/`false`/`null`), число картинок в Music, наличие картинки в аудиофайле и lyrics. Это справочные сведения на момент экспорта; они не записываются как теги. Условия отбора остаются в команде; отдельного `selection.filter` в запросе нет. Порядок строк соответствует `--sort`.

Избранное читается через `favorited`, для старого Music предусмотрен `loved`. Если приложение не предоставляет ни одного свойства, фильтрация/сортировка по избранному выдаёт понятную ошибку. Неизвестное значение не считается `false`: НЕ неизвестного также неизвестно. Записи, для которых всё условие осталось неизвестным, исключаются; их число выводится в консоль.

Отбор читает столбцы Music пакетно: нужные для фильтров/сортировки и краткого вывода. При экспорте дополнительно собираются полные сведения выбранных записей, включая наличие встроенных обложек и текста. Хеши аудио вычисляются позднее, в `prepare`. Порядок ID проверяется между пакетными чтениями; если запись перестала соответствовать фильтру или её локальный файл недоступен/защищён, экспорт останавливается с ошибкой и ID, частичный запрос не сохраняется. Лёгкий просмотр может показывать и облачные записи. Фильтры используют текущие теги и не определяют музыкальную принадлежность.

Для проверки полученного снимка:

```sh
./music-tags audit runs/or-v1.json runs/or-audit-v1.json
```

`audit` читает старый снимок или новый запрос. Метаданные запроса оцениваются по черновику, наличие обложек и lyrics — по `info` на момент экспорта. Заполнение `lyrics_file` ещё не означает, что текст записан в трек.

Исправляй **тот же файл**, сохраняя `id` и `expect`. Пути к JPEG/PNG и UTF-8 TXT задавай относительно этого JSON. Затем:

```sh
./music-tags validate runs/klass-czar-v1.json
./music-tags prepare runs/klass-czar-v1.json runs/klass-czar-plan-v1.json
./music-tags preview runs/klass-czar-plan-v1.json
```

Только `apply` применяет проверенный план. Новые экспорты и планы сохраняй под новыми именами. Если совпадений нет, JSON не создаётся. Старые снимки остаются пригодны для `audit`, но напрямую для `prepare` не подходят — сделай новый экспорт.
