/*
===========================================================
   KITABWORM - BOOK READER
===========================================================

   Opens the book the user picked from the home page list. The
   filename arrives as ?book=<filename> and the text is loaded from
   the project's books folder:

       books/<filename>

   There is no default book: without the parameter the reader shows a
   link back to the library.

   The script:

   1. Loads the novel.
   2. Detects chapters.
   3. Creates a real page-sized measuring element.
   4. Adds text until it no longer fits.
   5. Moves the overflowing text to the next page.
   6. Starts every chapter on a fresh page.
   7. Sends the generated pages to StPageFlip.
   8. Re-paginates when the screen size changes.

===========================================================
*/


/* =========================================================
   FILE LOCATIONS
   ========================================================= */

/*
   There is no default book. The reader opens exactly the book the user
   picked from the list on the home page, passed as ?book=<filename>.
*/
const selectedBookFile =
    new URLSearchParams(window.location.search).get("book");

/* Only ever read a file from this project's books folder. */
const BOOK_FILE =
    selectedBookFile
    && !selectedBookFile.includes("/")
    && !selectedBookFile.includes("..")
        ? selectedBookFile
        : null;

const BOOK_URL =
    BOOK_FILE
        ? `books/${encodeURIComponent(BOOK_FILE)}`
        : null;

function titleFromFilename(filename) {
    return filename
        .replace(/\.txt$/, "")
        .replace(/\\/g, "")
        .replace(/_/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, character => character.toUpperCase());
}

const BOOK_TITLE =
    BOOK_FILE
        ? titleFromFilename(BOOK_FILE)
        : "";

if (BOOK_FILE) {
    document.title = `${BOOK_TITLE} - KitabWorm`;
}

const COVER_URL = "assets/cover.png";
const BACKCOVER_URL = "assets/backcover.png";


/* =========================================================
   DOM
   ========================================================= */

let flipbookEl = document.querySelector(".flipbook");
const loadingEl = document.querySelector("#loading");


/*
   State classes shared with style.css. is-ready fades the finished
   book in; is-done fades the loading screen out.
*/
const READY_CLASS = "is-ready";
const DONE_CLASS = "is-done";


/*
   Page size of the book currently on screen. Used to skip work when a
   rebuild would produce exactly the same pages -- document.fonts.ready
   and the first visualViewport resize both fire on every load, and
   repaginating for them used to make the book blink out and back in.
*/
let renderedSettingsKey = null;


/*
   Fades are decorative: the class that reveals the book is applied
   first, so the resting state is always "visible", and the animation is
   a bonus on top. An animation that never runs can therefore never hide
   the book.
*/
function prefersReducedMotion() {

    return (
        window.matchMedia
        &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
}


function revealBook() {

    flipbookEl.classList.add(
        READY_CLASS
    );

    if (prefersReducedMotion()) {
        return;
    }

    const fade =
        flipbookEl.animate(
            [
                {
                    opacity: 0,
                    transform: "translateY(12px) scale(0.994)"
                },
                {
                    opacity: 1,
                    transform: "none"
                }
            ],
            {
                duration: 420,
                easing: "cubic-bezier(0.2, 0.7, 0.3, 1)"
            }
        );

    /* Drop the animation once it is done so the plain CSS state
       (opacity 1) is what keeps the book on screen. */
    fade.finished.then(
        () => fade.cancel()
    ).catch(
        () => {}
    );
}


function dismissLoadingScreen() {

    const hide = () => loadingEl.classList.add(
        DONE_CLASS
    );

    if (prefersReducedMotion()) {
        hide();
        return;
    }

    const fade = loadingEl.animate(
        [
            { opacity: 1 },
            { opacity: 0 }
        ],
        {
            duration: 380,
            easing: "ease"
        }
    );

    /*
       The timeout guarantees the overlay is removed even if the fade
       never reports completion.
    */

    Promise.race(
        [
            fade.finished,
            new Promise(resolve => setTimeout(resolve, 600))
        ]
    ).then(hide, hide);
}


/* =========================================================
   STATE
   ========================================================= */

let pageFlip = null;

// The cover is 1001 × 1571. Keeping its known aspect ratio here means the
// reader can start laying out immediately instead of waiting for image decode.
let coverAspect = 1001 / 1571;

let bookText = "";

let resizeTimer = null;

let pageJumpIsSetup = false;

let cachedNodes = null;

let cachedSettingsKey = "";

let sharedMeasurer = null;

/* Height (px) reserved below the book for the controls on mobile. */
const CONTROL_BAR_HEIGHT = 120;


/* Pinch-to-font-size gesture state. */
let pinchStartDistance = null;
let pinchBaseScale = 1;
let pinchCurrentTarget = 1;

let pinchIsSetup = false;


/* =========================================================
   TEXT SIZE
   ========================================================= */

/*
   The reader does not scroll: pages are measured and cut to fit a fixed
   page size before they are shown. Changing the font size therefore has to
   re-paginate the whole book, not restyle the existing pages.

   The size is a CSS custom property (--reader-font-scale) so the measuring
   page and the real pages always agree, and it is kept in localStorage only:
   nothing is sent anywhere and no server is involved.
*/

const FONT_SCALE_MIN = 0.8;
const FONT_SCALE_MAX = 1.6;
const FONT_SCALE_STEP = 0.1;
const FONT_SCALE_DEFAULT = 1;
const FONT_SCALE_STORAGE_KEY = "kitabworm:font-scale";

let fontScale = readStoredFontScale();

let fontScaleTimer = null;

let fontControlIsSetup = false;

/* Rebuilds requested by the font buttons that have not finished yet. */
let pendingFontRebuilds = 0;


/* Rebuilds are chained so a resize, a font change and a font-load event can
   never build two flipbooks at the same time. */
let initChain = Promise.resolve();


/*
   Character offset in the book at which each text page begins, indexed by
   page node. Null on the cover, the blank page and the back cover.

   Reflowing the book at a new font size moves every page break. These
   offsets are what lets the reader land on the same sentence again instead
   of jumping back to the cover.
*/
let pageStartOffsets = [];


/* =========================================================
   TEXT SIZE HELPERS
   ========================================================= */

function clampFontScale(value) {

    return Math.min(
        FONT_SCALE_MAX,
        Math.max(
            FONT_SCALE_MIN,
            value
        )
    );
}


/* Keeps the scale on the 0.8 / 0.9 / 1.0 ... grid so every step is stable. */
function snapFontScale(value) {

    const steps =
        Math.round(
            (value - FONT_SCALE_DEFAULT) / FONT_SCALE_STEP
        );

    return clampFontScale(
        FONT_SCALE_DEFAULT + steps * FONT_SCALE_STEP
    );
}


function readStoredFontScale() {

    try {

        const stored =
            window.localStorage.getItem(
                FONT_SCALE_STORAGE_KEY
            );

        if (!stored) {
            return FONT_SCALE_DEFAULT;
        }

        const parsed =
            parseFloat(stored);

        if (!Number.isFinite(parsed)) {
            return FONT_SCALE_DEFAULT;
        }

        return snapFontScale(parsed);

    } catch (error) {

        /* Private mode or a file:// origin can refuse storage. */
        return FONT_SCALE_DEFAULT;

    }
}


function storeFontScale(value) {

    try {

        window.localStorage.setItem(
            FONT_SCALE_STORAGE_KEY,
            String(value)
        );

    } catch (error) {

        /* Not being able to remember the size is not worth failing over. */

    }
}


/* Must run before the first pagination so the book opens at the chosen size. */
function applyFontScale() {

    document.documentElement.style.setProperty(
        "--reader-font-scale",
        String(fontScale)
    );
}


/* =========================================================
   NORMALIZE NOVEL TEXT
   ========================================================= */

function normalizeText(text) {

    return text

        // Remove UTF-8 BOM if present
        .replace(/^\uFEFF/, "")

        // Normalize Windows line endings
        .replace(/\r\n?/g, "\n")

        // Remove spaces at the end of lines
        .replace(/[ \t]+\n/g, "\n")

        // Prevent huge blank areas
        .replace(/\n{3,}/g, "\n\n")

        .trim();
}


/* =========================================================
   NORMALIZE CHAPTER TITLE
   ========================================================= */

function normalizeHeading(text) {

    return text
        .replace(/\s+/g, " ")
        .trim();
}


/* =========================================================
   SPLIT NOVEL INTO CHAPTERS
=========================================================

   Detects:

       CHAPTER I
       CHAPTER II
       CHAPTER 1
       CHAPTER 2
       Chapter I
       Chapter 1

========================================================= */

function splitIntoChapters(text) {

    const normalized = normalizeText(text);

    const chapterRegex =
        /^\s*(CHAPTER\s+(?:[IVXLCDM]+|\d+)[^\n]*)\s*$/gim;

    const matches = [
        ...normalized.matchAll(chapterRegex)
    ];


    /*
       If no chapter headings were detected,
       keep the entire book as one section.
    */

    if (matches.length === 0) {

        return [
            {
                title: BOOK_TITLE,
                text: normalized
            }
        ];
    }


    const chapters = [];


    /*
       Anything before the first chapter.
    */

    const beforeFirst =
        normalized
            .slice(0, matches[0].index)
            .trim();


    if (beforeFirst) {

        chapters.push({
            title: BOOK_TITLE,
            text: beforeFirst
        });
    }


    /*
       Create each chapter independently.
    */

    for (let i = 0; i < matches.length; i++) {

        const match = matches[i];

        const start = match.index;

        const end =
            i + 1 < matches.length
                ? matches[i + 1].index
                : normalized.length;


        const heading =
            normalizeHeading(match[1]);


        const chapterText =
            normalized
                .slice(
                    start + match[0].length,
                    end
                )
                .trim();


        chapters.push({

            title: heading,

            text: chapterText
        });
    }


    return chapters;
}


/* =========================================================
   CONVERT CHAPTER TEXT INTO PARAGRAPHS
   ========================================================= */

function paragraphsFromText(text) {

    return text

        .split(/\n\s*\n/)

        .map(paragraph =>

            paragraph
                .replace(/\s*\n\s*/g, " ")
                .trim()

        )

        .filter(Boolean);
}


/* =========================================================
   GET BOOK PAGE SIZE
========================================================= */

function getSettings() {

    const isMobile =
        window.innerWidth <= 768;


    const viewportWidth =
        window.visualViewport
            ? window.visualViewport.width
            : window.innerWidth;


    const viewportHeight =
        window.visualViewport
            ? window.visualViewport.height
            : window.innerHeight;


    let width;
    let height;


    /*
       MOBILE

       One page at a time.
    */

    if (isMobile) {

        width =
            Math.max(
                200,
                viewportWidth
            );


        height =
            width / coverAspect;


        if (height > viewportHeight - CONTROL_BAR_HEIGHT) {

            height =
                Math.max(
                    200,
                    viewportHeight - CONTROL_BAR_HEIGHT
                );


                width =
                height * coverAspect;
        }
    }


    /*
       DESKTOP

       Two pages side-by-side.

       Therefore one page gets roughly
       half the available width.
    */

    else {

        const availableWidth =
            viewportWidth - 30;


        width =
            Math.min(
                availableWidth / 2,
                700
            );


        height =
            width / coverAspect;


        if (height > viewportHeight - 20) {

            height =
                viewportHeight - 20;


            width =
                height * coverAspect;
        }
    }

return {

        width: Math.round(width),

        height: Math.round(height),

        usePortrait: isMobile,

        fontScale

    };
}


/* =========================================================
   CREATE MEASURING PAGE
=========================================================

   This page is invisible.

   Its dimensions and CSS are the same as the
   actual book page.

   We use it to determine whether text fits.

========================================================= */

function createMeasurer(settings) {

    if (sharedMeasurer) {
        sharedMeasurer.style.width =
            `${settings.width}px`;

        sharedMeasurer.style.height =
            `${settings.height}px`;

        return sharedMeasurer;
    }

    const measurer =
        document.createElement("div");

    measurer.className =
        "pagination-measurer page";

    measurer.style.width =
        `${settings.width}px`;

    measurer.style.height =
        `${settings.height}px`;

    document.body.appendChild(measurer);

    sharedMeasurer = measurer;

    return measurer;
}


/* =========================================================
   CONFIGURE MEASURER
   ========================================================= */

function configureMeasurer(measurer) {

    measurer.innerHTML = `

        <div class="chapter-title"></div>

        <div class="page-text"></div>

    `;


    const textContainer =
        measurer.querySelector(".page-text");


    return textContainer;
}


/* =========================================================
   CHECK WHETHER PAGE FITS
========================================================= */

function fits(measurer) {

    return (
        measurer.scrollHeight
        <=
        measurer.clientHeight + 1
    );
}


/* =========================================================
   TAKE WORDS FROM THE START OF A PARAGRAPH
========================================================= */

function splitParagraphIntoWords(paragraph) {

    return paragraph.match(/\S+\s*/g) || [];
}


/*
   startOffset is this chapter's position in the flattened book text, so
   every page can record where in the novel it begins.
*/
function paginateChapter(
    chapter,
    settings,
    startOffset
) {

    let paragraphs =
        paragraphsFromText(chapter.text);


    const measurer =
        createMeasurer(settings);


    const textContainer =
        configureMeasurer(measurer);


    const titleElement =
        measurer.querySelector(".chapter-title");


    const pages = [];


    let paragraphIndex = 0;

    let firstPage = true;


    /*
       Walks through the chapter's text as if the paragraphs were joined by a
       single separator. The exact value does not matter; it only has to grow
       in step with the text so offsets stay comparable between paginations.
    */
    let cursor = startOffset;


    while (
        paragraphIndex <
        paragraphs.length
    ) {

        const pageParagraphs = [];


        /*
           Where this page starts in the book.
        */

        const pageStart = cursor;


        /*
           Chapter heading only appears on
           the first page of the chapter.
        */

        if (firstPage) {

            titleElement.textContent =
                chapter.title || "";

        } else {

            titleElement.textContent =
                "";
        }


        textContainer.innerHTML = "";


        /*
        =====================================================
           FILL CURRENT PAGE
        =====================================================
        */

        while (
            paragraphIndex <
            paragraphs.length
        ) {

            const paragraph =
                paragraphs[paragraphIndex];

            const paragraphLength =
                paragraph.length;


            /*
               First try the entire paragraph.
            */

            const paragraphElement = document.createElement("p");
            paragraphElement.textContent = paragraph;
            textContainer.appendChild(paragraphElement);


            if (fits(measurer)) {

                pageParagraphs.push(paragraph);

                paragraphIndex++;

                cursor += paragraphLength + 1;

                continue;
            }


            /*
            =================================================
               WHOLE PARAGRAPH DOES NOT FIT

               Remove it and add words one by one.
            =================================================
            */

            paragraphElement.remove();


            const words =
                splitParagraphIntoWords(paragraph);


            /*
               Find the last word that fits. The previous implementation
               rebuilt every paragraph on the page for every single word;
               binary search needs only log2(word count) layout checks.
            */
            const splitElement = document.createElement("p");
            textContainer.appendChild(splitElement);

            let low = 0;
            let high = words.length;

            while (low < high) {
                const middle = Math.ceil((low + high) / 2);
                splitElement.textContent = words.slice(0, middle).join("").trim();

                if (fits(measurer)) {
                    low = middle;
                } else {
                    high = middle - 1;
                }
            }

            const lastGood = words.slice(0, low).join("").trim();
            splitElement.remove();


            /*
            =================================================
               SOME WORDS FIT
            =================================================
            */

            if (lastGood) {

                pageParagraphs.push(
                    lastGood
                );


                /*
                   Remove the words that were already
                   placed on this page from the paragraph.

                   Use word count rather than character
                   count so whitespace differences do not
                   cause text to disappear.
                */

                const usedWords = low;


                const remainingWords =
                    words.slice(usedWords);


                paragraphs[paragraphIndex] =
                    remainingWords
                        .join("")
                        .trim();


                /*
                   Everything taken off the front of this paragraph is now
                   on the page, so the cursor moves by exactly that much.
                */

                cursor +=
                    paragraphLength -
                    paragraphs[paragraphIndex].length;


                /*
                   If nothing remains from this paragraph,
                   move to the next paragraph.
                */

                if (
                    paragraphs[paragraphIndex]
                        .length === 0
                ) {

                    paragraphIndex++;

                    cursor += 1;
                }
            }


            /*
            =================================================
               NOTHING FIT

               Current page is full.

               Finish it and try the paragraph again
               on the next page.
            =================================================
            */

            else if (
                pageParagraphs.length > 0
            ) {

                break;
            }


            /*
            =================================================
               EXTREMELY LONG WORD

               Prevent infinite loop.
            =================================================
            */

            else {

                pageParagraphs.push(
                    paragraph
                );

                paragraphIndex++;

                cursor += paragraphLength + 1;
            }


            break;
        }


        /*
           Safety check.
        */

        if (
            pageParagraphs.length === 0
        ) {

            break;
        }


        /*
           Save completed page.
        */

        pages.push({

            title:
                firstPage
                    ? chapter.title
                    : "",

            paragraphs:
                pageParagraphs,

            /*
               Position of this page in the flattened book text, used to
               restore the reading position after a re-pagination.
            */

            start:
                pageStart
        });


        firstPage = false;
    }


    /*
       Reusable measurer stays in DOM.
    */


    return {

        pages,

        endOffset: cursor

    };
}


/* =========================================================
   BUILD ACTUAL HTML PAGE
========================================================= */

function buildPageElement(
    pageData,
    pageNumber
) {

    const page =
        document.createElement("div");


    page.className =
        "page";


    /*
       Chapter heading.
    */

    if (pageData.title) {

        const heading =
            document.createElement("h2");


        heading.className =
            "chapter-title";


        heading.textContent =
            pageData.title;


        page.appendChild(heading);
    }


    /*
       Text container.
    */

    const text =
        document.createElement("div");


    text.className =
        "page-text";


    /*
       Add paragraphs.
    */

    for (
        const paragraph
        of pageData.paragraphs
    ) {

        const p =
            document.createElement("p");


        p.textContent =
            paragraph;


        text.appendChild(p);
    }


    page.appendChild(text);


    /*
       Page number.
    */

    const number =
        document.createElement("div");


    number.className =
        "page-number";


    number.textContent =
        pageNumber;


    page.appendChild(number);


    return page;
}


/* =========================================================
   YIELD TO THE BROWSER

   Paginating a long book is thousands of forced layouts. Handing control
   back for one frame lets the busy state paint and keeps the buttons
   responsive. The timeout guarantees the yield can never wedge the
   reader if a frame callback is delayed.
   ========================================================= */

function yieldToBrowser() {

    return new Promise(resolve => {

        let settled = false;

        const finish = () => {

            if (settled) {
                return;
            }

            settled = true;
            resolve();

        };

        requestAnimationFrame(finish);

        setTimeout(finish, 60);

    });
}


/* =========================================================
   BUILD ALL BOOK PAGES
   ========================================================= */

async function buildAllPages(settings) {

    const settingsKey =
        `${settings.width}-${settings.height}` +
        `:${settings.fontScale}`;


    if (
        cachedNodes &&
        cachedSettingsKey === settingsKey
    ) {

        return cachedNodes;
    }


    const chapters =
        splitIntoChapters(bookText);


    const pageDataList = [];


    let cursor = 0;
    let lastYield = performance.now();


    for (
        const chapter
        of chapters
    ) {

        const result =
            paginateChapter(
                chapter,
                settings,
                cursor
            );


        cursor = result.endOffset;

        pageDataList.push(
            ...result.pages
        );


        /*
           Long chapters are measured one after another; hand the frame back
           from time to time so the reader can paint its busy state.
        */

        const now = performance.now();

        if (now - lastYield > 60) {

            await yieldToBrowser();

            lastYield = performance.now();

        }
    }


    const nodes = [];

    /*
       Offset of every page node, so a re-paginated book can find the page
       that holds the text the reader was on. Null means "no text here".
    */
    const offsets = [];


    const cover =
        document.createElement("div");


    cover.className =
        "page cover";


    const image =
        document.createElement("img");


    image.src =
        COVER_URL;


    image.alt =
        `${BOOK_TITLE} book cover`;


    image.className =
        "cover-image";

    image.width = 1001;
    image.height = 1571;


    cover.appendChild(image);


    nodes.push(cover);

    offsets.push(null);


    /*
    =========================================================
       EMPTY PAGE AFTER COVER
    =========================================================
    */

    const emptyPage =
        document.createElement("div");

    emptyPage.className =
        "page";

    nodes.push(emptyPage);

    offsets.push(null);


    /*
    =========================================================
       TEXT PAGES
    =========================================================
    */

    pageDataList.forEach(
        (pageData, index) => {

            nodes.push(

                buildPageElement(
                    pageData,
                    index + 1
                )

            );

            offsets.push(pageData.start);

        }
    );


    if (
        pageDataList.length % 2 === 0
    ) {

        const extraEmptyPage =
            document.createElement(
                "div"
            );

        extraEmptyPage.className =
            "page";

        nodes.push(extraEmptyPage);

        offsets.push(null);
    }


    /*
    =========================================================
       BACKCOVER
    =========================================================
    */

    const backCover =
        document.createElement("div");

    backCover.className =
        "page cover backcover";

    const backImage =
        document.createElement("img");

    backImage.src =
        BACKCOVER_URL;

    backImage.alt =
        `${BOOK_TITLE} book back cover`;

    backImage.className =
        "cover-image";

    backImage.width = 848;
    backImage.height = 1264;

    backCover.appendChild(backImage);

    nodes.push(backCover);

    offsets.push(null);


    cachedNodes = nodes;
    cachedSettingsKey = settingsKey;
    pageStartOffsets = offsets;


    return nodes;
}


/* =========================================================
   LOAD COVER
========================================================= */

function preloadCover() {

    return new Promise(resolve => {

        const image =
            new Image();


        image.onload = () => {

            if (
                image.naturalWidth &&
                image.naturalHeight
            ) {

                coverAspect =
                    image.naturalWidth /
                    image.naturalHeight;
            }


            resolve();
        };


        image.onerror = () => {

            coverAspect = 3 / 4;

            resolve();
        };


        image.src =
            COVER_URL;
    });
}


/* =========================================================
   LOAD NOVEL TEXT FILE
========================================================= */

async function loadBookText() {

    const response =
        await fetch(
            BOOK_URL,
            {
                // Reuse the cached local book when reopening the reader.
                // The text file has a URL of its own, so normal cache
                // invalidation still works when it is updated.
                cache: "force-cache"
            }
        );


    if (!response.ok) {

        throw new Error(
            `Could not load ${BOOK_URL} ` +
            `(HTTP ${response.status}).`
        );
    }


    const text =
        await response.text();


    return normalizeText(text);
}


/* =========================================================
   READING POSITION
   ========================================================= */

/*
   Records where the reader is before the book is rebuilt, so a font-size
   change or a window resize does not throw them back to the cover.
*/
function captureReadingAnchor() {

    if (!pageFlip) {
        return null;
    }

    const total =
        pageFlip.getPageCount();

    if (!total) {
        return null;
    }

    const index =
        pageFlip.getCurrentPageIndex();

    const offset =
        pageStartOffsets[index];


    /* A text page: remember the exact spot in the novel. */
    if (
        typeof offset === "number"
    ) {

        return { offset };

    }


    /*
       Cover, blank page or back cover hold no text, so fall back to the
       relative position in the book.
    */

    return {
        ratio:
            index /
            Math.max(1, total - 1)
    };
}


/* Index of the last page that starts at or before the given offset. */
function pageIndexForOffset(offset) {

    let match = 0;

    for (
        let index = 0;
        index < pageStartOffsets.length;
        index++
    ) {

        const start =
            pageStartOffsets[index];

        if (typeof start !== "number") {
            continue;
        }

        if (start > offset) {
            break;
        }

        match = index;
    }

    return match;
}


function restoreReadingPosition(anchor) {

    if (!pageFlip || !anchor) {
        return;
    }

    const total =
        pageFlip.getPageCount();

    if (!total) {
        return;
    }

    let target = 0;

    if (typeof anchor.offset === "number") {
        target = pageIndexForOffset(anchor.offset);
    }

    else if (typeof anchor.ratio === "number") {
        target =
            Math.round(
                anchor.ratio * (total - 1)
            );
    }

    else {
        return;
    }

    target =
        Math.min(
            total - 1,
            Math.max(0, target)
        );

    /* 0 is where the book already opens. */
    if (target <= 0) {
        return;
    }

    try {

        pageFlip.turnToPage(target);

    } catch (error) {

        console.warn(
            "Could not restore reading position:",
            error
        );

    }
}


/* =========================================================
   INITIALIZE BOOK
   ========================================================= */

/*
   restore: where to land again once the pages have been rebuilt. See
   captureReadingAnchor().
*/
async function initFlipbook(restore = null) {

    try {

        loadingEl.classList.remove(
            "error"
        );


        loadingEl.textContent =
            "Opening book…";


        /*
           Load the cover and text concurrently. The known cover dimensions
           above let pagination begin as soon as the text is available.
        */
        const coverPromise = preloadCover();

        if (!bookText) {
            bookText = await loadBookText();
        }

        // Do not hold the reader behind a multi-megabyte image decode.
        void coverPromise;


        /*
           Determine current page size.
        */

        const settings =
            getSettings();


        const settingsKey =
            `${settings.width}x${settings.height}` +
            `:${settings.usePortrait}` +
            `:${settings.fontScale}`;


        /*
           Nothing that affects pagination has changed, so rebuilding
           would only throw the visible book away and rebuild the same
           pages. Leave it alone.
        */

        if (
            renderedSettingsKey === settingsKey
        ) {
            return;
        }

        renderedSettingsKey = settingsKey;


        /*
           Create all pages according
           to actual dimensions.
        */

        const nodes =
            await buildAllPages(
                settings
            );


        /*
           Destroy old StPageFlip instance
           when resizing.
        */

        if (pageFlip) {

            try {

                pageFlip.destroy();

            } catch (error) {

                console.warn(
                    "Could not destroy previous page flip:",
                    error
                );
            }


            pageFlip = null;
        }


        /*
           StPageFlip's destroy() removes its parent element. Reattach the
           reader container before building a new instance on a resize or
           after fonts finish loading.
        */

        if (!flipbookEl.isConnected) {

            document
                .querySelector(".reader-shell")
                .prepend(flipbookEl);
        }


        /*
           Clear old pages.
        */

        flipbookEl.innerHTML = "";


        /*
           Add newly generated pages.
        */

        nodes.forEach(node => {

            flipbookEl.appendChild(node);

        });


        /*
           Fade the book out while StPageFlip
           initializes, so a repagination never
           makes it blink.
        */

        flipbookEl.classList.remove(
            READY_CLASS
        );


        /*
           Wait for browser layout.
        */

        await new Promise(resolve => {

            requestAnimationFrame(resolve);

        });


        /*
        =====================================================
           STPAGEFLIP
        =====================================================
        */

        pageFlip =
            new St.PageFlip(
                flipbookEl,
                {

                    width:
                        settings.width,

                    height:
                        settings.height,

                    size:
                        "fixed",

                    minWidth:
                        settings.width,

                    maxWidth:
                        settings.width,

                    minHeight:
                        settings.height,

                    maxHeight:
                        settings.height,

                    showCover:
                        true,

                    mobileScrollSupport:
                        true,

                    flippingTime:
                        500,

                    /*
                       Desktop:
                       two pages.

                       Mobile:
                       one page.
                    */

                    usePortrait:
                        settings.usePortrait,

                    startZIndex:
                        1,

                    autoSize:
                        false,

                    drawShadow:
                        true,

                    maxShadowOpacity:
                        0.95,

                    showPageCorners:
                        true,

                    clickEventForward:
                        true,

                    useMouseEvents:
                        true,

                    swipeDistance:
                        30,

                    /* Single tap turns the page like desktop; swipes also
                       work on mobile. */
                    disableFlipByClick:
                        false,

                    startPage:
                        0
                }
            );


        /*
           Give generated pages to StPageFlip.
        */

        pageFlip.loadFromHTML(
            nodes
        );


        /*
           Put the reader back on the text it was reading before the
           re-pagination moved every page break.
        */

        if (restore) {
            restoreReadingPosition(restore);
        }


        /*
           Reveal book: the loading screen fades out
           while the pages fade in.
        */

        revealBook();

        dismissLoadingScreen();


        console.log(
            "Book loaded successfully."
        );

        console.log(
            `Total pages: ${nodes.length - 1}`
        );

        console.log(
            `Chapters/sections: ${
                splitIntoChapters(bookText).length
            }`
        );


        setupPageJump();

    }

    catch (error) {

        console.error(
            "Failed to initialize book:",
            error
        );


        /* Allow a retry with the same page size. */
        renderedSettingsKey = null;


        flipbookEl.classList.remove(
            READY_CLASS
        );


        loadingEl.classList.remove(
            DONE_CLASS
        );


        loadingEl.classList.add(
            "error"
        );


        loadingEl.textContent =
            `${error.message} ` +
            `Make sure the project is running through ` +
            `a local web server and that ` +
            `${BOOK_URL} exists.`;
    }
}


/* =========================================================
   HANDLE RESIZE
=========================================================

   When the screen changes size:

   The number of words that fit on a page changes.

   Therefore we MUST paginate the book again.

========================================================= */

function scheduleResize() {

    clearTimeout(
        resizeTimer
    );


    resizeTimer =
        setTimeout(
            () => {

                queueFlipbookInit(
                    captureReadingAnchor()
                );

            },
            300
        );
}


/*
   Every rebuild goes through this queue. A resize, a font-size change and a
   finished web font can all arrive at once, and two flipbooks must never be
   built on top of each other.
*/
function queueFlipbookInit(restore = null) {

    initChain =
        initChain
            .then(() => initFlipbook(restore))
            .catch(() => {
                /* initFlipbook reports its own errors. */
            });

    return initChain;
}


/* =========================================================
   BROWSER EVENTS
========================================================= */

window.addEventListener(
    "resize",
    scheduleResize
);


window.addEventListener(
    "orientationchange",
    () => {

        const anchor =
            captureReadingAnchor();

        setTimeout(
            () => {

                queueFlipbookInit(anchor);

            },
            400
        );
    }
);


/*
   Mobile browser viewport changes.
*/

if (window.visualViewport) {

    window.visualViewport.addEventListener(
        "resize",
        scheduleResize
    );
}


/*
   Wait for fonts before final pagination.
*/

if (
    document.fonts &&
    document.fonts.ready
) {

    document.fonts.ready.then(() => {

        if (bookText) {

            scheduleResize();
        }

    });
}


/* =========================================================
   PAGE JUMP
   ========================================================= */

function setupPageJump() {

    if (pageJumpIsSetup) {
        return;
    }

    const input =
        document.getElementById(
            "pageJumpInput"
        );


    const button =
        document.getElementById(
            "pageJumpBtn"
        );


    if (!input || !button) {
        return;
    }


    pageJumpIsSetup = true;


    function jumpToPage() {

        const pageNumber =
            parseInt(
                input.value,
                10
            );


        if (
            !pageNumber ||
            pageNumber < 1
        ) {
            return;
        }


        if (!pageFlip) {
            return;
        }


        const totalContentPages =
            pageFlip.getPageCount() - 2;


        if (
            pageNumber > totalContentPages
        ) {
            input.value = "";

            alert(
                `This book only has ${totalContentPages} content pages.`
            );

            return;
        }


        const targetIndex =
            pageNumber + 1;


        pageFlip.turnToPage(
            targetIndex
        );
    }


    button.addEventListener(
        "click",
        jumpToPage
    );


    input.addEventListener(
        "keydown",
        (event) => {

            if (
                event.key === "Enter"
            ) {
                jumpToPage();
            }
        }
    );
}


/* =========================================================
   NO BOOK SELECTED
   Opening the reader without ?book= shows a pointer back to the
   library instead of silently opening some arbitrary title.
   ========================================================= */

function showBookChooser() {

    loadingEl.classList.add(
        "notice"
    );

    const message =
        document.createElement("p");

    message.textContent =
        "No book selected.";


    const link =
        document.createElement("a");

    link.href = "index.html#library";
    link.textContent = "Choose a book from the library";


    loadingEl.replaceChildren(
        message,
        link
    );
}


/* =========================================================
   TEXT SIZE CONTROL

   The buttons change --reader-font-scale, which only the text inside the
   book pages reads. The book is then re-paginated at the new size and the
   reader is put back on the passage they were on.
   ========================================================= */

function updateFontControl() {

    const control =
        document.getElementById(
            "fontSizeControl"
        );

    const readout =
        document.getElementById(
            "fontSizeValue"
        );

    const down =
        document.getElementById(
            "fontSizeDown"
        );

    const up =
        document.getElementById(
            "fontSizeUp"
        );


    if (!control || !readout) {
        return;
    }

    readout.textContent =
        `${Math.round(fontScale * 100)}%`;

    if (down) {
        down.disabled =
            fontScale <= FONT_SCALE_MIN;
    }

    if (up) {
        up.disabled =
            fontScale >= FONT_SCALE_MAX;
    }

    control.setAttribute(
        "aria-label",
        `Text size ${Math.round(fontScale * 100)} percent`
    );
}


function setFontBusy(isBusy) {

    const control =
        document.getElementById(
            "fontSizeControl"
        );

    if (!control) {
        return;
    }

    control.classList.toggle(
        "is-busy",
        isBusy
    );

    control.setAttribute(
        "aria-busy",
        isBusy ? "true" : "false"
    );
}


function setFontScale(requestedScale) {

    const nextScale =
        snapFontScale(requestedScale);

    if (nextScale === fontScale) {
        updateFontControl();
        return;
    }

    fontScale = nextScale;


    /*
       The custom property drives the measuring page as well, so the very
       next pagination measures the size that is about to be shown.
    */

    applyFontScale();

    storeFontScale(fontScale);

    updateFontControl();


    /*
       No book is open yet: the reader simply opens at the chosen size.
    */

    if (!bookText) {
        return;
    }

    /*
       Captured before the rebuild. Offsets are positions in the novel's
       text, so they stay valid across any number of re-paginations.
    */

    const anchor =
        captureReadingAnchor();

    clearTimeout(
        fontScaleTimer
    );


    /*
       Rapid clicks collapse into one rebuild of the final size. The busy
       counter is raised here, once per rebuild actually queued, so it always
       balances out again.
    */

    fontScaleTimer =
        setTimeout(() => {

            pendingFontRebuilds++;

            setFontBusy(true);

            queueFlipbookInit(anchor)
                .then(() => {

                    pendingFontRebuilds =
                        Math.max(
                            0,
                            pendingFontRebuilds - 1
                        );

                    if (pendingFontRebuilds === 0) {
                        setFontBusy(false);
                    }

                });

        }, 120);
}


/* Ctrl / Cmd + plus and minus, Ctrl / Cmd + 0 to reset. */
function isFontSizeShortcut(event) {

    return (
        event.ctrlKey || event.metaKey
    ) && !event.altKey;

}


function setupFontSizeControl() {

    if (fontControlIsSetup) {
        return;
    }

    const control =
        document.getElementById(
            "fontSizeControl"
        );

    const down =
        document.getElementById(
            "fontSizeDown"
        );

    const up =
        document.getElementById(
            "fontSizeUp"
        );

    if (!control || !down || !up) {
        return;
    }

    fontControlIsSetup = true;


    down.addEventListener(
        "click",
        () => {

            setFontScale(
                fontScale - FONT_SCALE_STEP
            );

        }
    );


    up.addEventListener(
        "click",
        () => {

            setFontScale(
                fontScale + FONT_SCALE_STEP
            );

        }
    );


    window.addEventListener(
        "keydown",
        (event) => {

            const target =
                event.target;

            /* Never steal keys from the page number field. */
            if (
                target &&
                (
                    target.tagName === "INPUT" ||
                    target.tagName === "TEXTAREA" ||
                    target.isContentEditable
                )
            ) {
                return;
            }

            if (!isFontSizeShortcut(event)) {
                return;
            }

            if (
                event.key === "+" ||
                event.key === "="
            ) {

                event.preventDefault();

                setFontScale(
                    fontScale + FONT_SCALE_STEP
                );

                return;
            }

            if (
                event.key === "-" ||
                event.key === "_"
            ) {

                event.preventDefault();

                setFontScale(
                    fontScale - FONT_SCALE_STEP
                );

                return;
            }

            if (event.key === "0") {

                event.preventDefault();

                setFontScale(
                    FONT_SCALE_DEFAULT
                );

            }

        }
    );


    updateFontControl();
}


/* =========================================================
   PINCH TO CHANGE FONT SIZE

   Two fingers moving apart or together on the book change the text
   size instead of zooming the page. The distance at gesture start is
   compared to the live distance and mapped onto the 0.1-step scale.
   ========================================================= */

function touchDistance(touches) {

    const dx =
        touches[0].clientX -
        touches[1].clientX;

    const dy =
        touches[0].clientY -
        touches[1].clientY;

    return Math.hypot(dx, dy);
}


function setupPinchGesture() {

    if (pinchIsSetup) {
        return;
    }

    if (!flipbookEl) {
        return;
    }

    pinchIsSetup = true;


    flipbookEl.addEventListener(
        "touchstart",
        (event) => {

            if (
                event.touches.length !== 2
            ) {
                return;
            }

            pinchStartDistance =
                touchDistance(event.touches);

            pinchBaseScale =
                fontScale;


            /* Stop the browser from zooming while the user pinches. */
            event.preventDefault();

        },
        { passive: false }
    );


    flipbookEl.addEventListener(
        "touchmove",
        (event) => {

            if (
                pinchStartDistance === null ||
                event.touches.length !== 2
            ) {
                return;
            }

            const ratio =
                touchDistance(event.touches) /
                pinchStartDistance;

            const target =
                snapFontScale(
                    pinchBaseScale * ratio
                );

            /*
               Apply the size straight away so the text responds while the
               fingers are still moving. The expensive re-pagination waits
               until the gesture ends.
            */

            document.documentElement.style.setProperty(
                "--reader-font-scale",
                String(target)
            );

            pinchCurrentTarget = target;

            updateFontControl();

            event.preventDefault();

        },
        { passive: false }
    );


    flipbookEl.addEventListener(
        "touchend",
        () => {

            pinchStartDistance = null;


            /*
               Re-paginate once at the final size so the pages fit the text
               exactly.
            */

            if (bookText) {
                setFontScale(pinchCurrentTarget);
            }

        }
    );


    flipbookEl.addEventListener(
        "touchcancel",
        () => {

            pinchStartDistance = null;

        }
    );
}


/* =========================================================
   START
   ========================================================= */

function start() {

    if (!BOOK_FILE) {

        showBookChooser();
        return;
    }


    /*
       The stored size has to be on the page before anything is measured.
    */

    applyFontScale();

    setupFontSizeControl();

    setupPinchGesture();

    queueFlipbookInit();
}


if (
    document.readyState === "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        start
    );

} else {

    start();
}
