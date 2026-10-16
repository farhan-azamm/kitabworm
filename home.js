/* =========================================================
   KITABWORM - HOME PAGE
   Builds the book grid and keeps the nav bar state in sync.
   Loaded only by index.html.
   ========================================================= */

"use strict";

/* Each entry points to a text file in the books folder. The reader
   receives the selected filename and keeps using its own logic. */
const BOOKS = [
    "a tale of two cities.txt",
    "anna_karenina.txt",
    "around the world in 80 days.txt",
    "bleak house.txt",
    "crime_and_punishment.txt",
    "david copperfield.txt",
    "dr jekkylle and mr hyde.txt",
    "dracula.txt",
    "emma.txt",
    "great expectations.txt",
    "hard times.txt",
    "jane eyre.txt",
    "kidnapped.txt",
    "les_miserables.txt",
    "little women.txt",
    "mansfield.txt",
    "moby dick.txt",
    "northanger abbey.txt",
    "oliver twist.txt",
    "persuasion.txt",
    "pride and prejudice.txt",
    "sense and sensibility.txt",
    "the_adventures_of_huckeleberry_finn.txt",
    "the_adventures of tom sawyer.txt",
    "the_brothers_karmazov.txt",
    "the call of the wild.txt",
    "the_count_of_monte_cristo.txt",
    "the_hunchback_of_notre_dame.txt",
    "the_illiad.txt",
    "the_invisible_man.txt",
    "the_island_of_doctor_moreau.txt",
    "the jungle book.txt",
    "The_ Man_ in _the_ Iron Mask.txt",
    "theMetamorphosis.txt",
    "the_odyssey.txt",
    "the pickwick papers.txt",
    "the_picture_of_dorian_gray.txt",
    "the_prince_and_the_pauper.txt",
    "the secret garden.txt",
    "the swiss family robinson.txt",
    "the tenant of wildfell hall.txt",
    "the_three_musketeers.txt",
    "the_time_machine.txt",
    "the_war_of_the_worlds.txt",
    "the white fang.txt",
    "the wonderful wizard of oz.txt",
    "treasure island.txt",
    "twenty thousand leagues under the sea.txt",
    "war_and_peace.txt",
    "wuthering heights .txt",
];

/* Words that stay lowercase unless they open or close a title. */
const SMALL_WORDS = new Set([
    "a", "an", "and", "as", "at", "but", "by", "for", "from",
    "in", "into", "nor", "of", "on", "onto", "or", "over", "per",
    "the", "to", "up", "via", "with", "vs"
]);


/* =========================================================
   TITLE FROM FILENAME
   "the_war_of_the_worlds.txt" -> "The War of the Worlds"
   ========================================================= */

function titleFromFilename(filename) {

    const words = filename
        .replace(/\\/g, "")
        .replace(/\.txt$/i, "")
        .replace(/_+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ");

    return words
        .map((word, index) => {

            const lower = word.toLowerCase();
            const isEdge = index === 0 || index === words.length - 1;

            if (!isEdge && SMALL_WORDS.has(lower)) {
                return lower;
            }

            return lower.charAt(0).toUpperCase() + lower.slice(1);

        })
        .join(" ")
        .trim();
}


/* =========================================================
   BOOK CARD
   ========================================================= */

function createBookCard(filename, position) {

    const title = titleFromFilename(filename);

    const card = document.createElement("a");
    card.className = "book-card";
    card.href = `reader.html?book=${encodeURIComponent(filename)}`;
    card.setAttribute("aria-label", `Read ${title}`);

    const frame = document.createElement("span");
    frame.className = "card-frame";
    frame.setAttribute("aria-hidden", "true");

    const number = document.createElement("span");
    number.className = "book-card-index";
    number.setAttribute("aria-hidden", "true");
    number.textContent = String(position).padStart(2, "0");

    const heading = document.createElement("h3");
    heading.className = "book-card-title";
    heading.textContent = title;

    const rule = document.createElement("span");
    rule.className = "book-card-rule";
    rule.setAttribute("aria-hidden", "true");

    const cta = document.createElement("span");
    cta.className = "book-card-cta";
    cta.setAttribute("aria-hidden", "true");
    cta.textContent = "Read";

    card.append(frame, number, heading, rule, cta);

    return card;
}


/* =========================================================
   RENDER THE GRID
   ========================================================= */

function renderBookGrid() {

    const grid = document.querySelector("#booksGrid");

    /* Guard against two filenames that resolve to the same title. */
    const seen = new Set();
    const files = BOOKS.filter(filename => {

        const title = titleFromFilename(filename);

        if (seen.has(title)) {
            return false;
        }

        seen.add(title);
        return true;

    });

    grid.replaceChildren(
        ...files.map((filename, index) => createBookCard(filename, index + 1))
    );

    const countLabel = document.querySelector("#collectionCount");

    if (countLabel) {
        countLabel.textContent =
            `${files.length} public-domain classics, ready to read.`;
    }
}


/* =========================================================
   NAV BAR
   Solid once the hero starts scrolling away.
   ========================================================= */

function initNav() {

    const nav = document.querySelector(".site-nav");

    const sync = () => nav.classList.toggle("is-scrolled", window.scrollY > 40);

    sync();

    window.addEventListener("scroll", sync, { passive: true });
}


renderBookGrid();
initNav();