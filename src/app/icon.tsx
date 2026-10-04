import { ImageResponse } from "next/og";

// FLUXO.OS favicon: a small black "x" followed by a large green ".OS" on
// the app's own cream background. Letters are converted to SVG paths from
// Bricolage Grotesque Bold, so no font loading is needed and it renders
// identically everywhere. Next.js renders this at build time and injects
// <link rel="icon">.

export const runtime = "edge";
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
        <rect x="1" y="1" width="62" height="62" rx="15" fill="#F5F3EE" stroke="#E0DACD" strokeWidth="2" />
        <path transform="translate(7.80 40.64) scale(0.01409 -0.01409)" d="M14 0 188 263 14 525H180L276 327H293L389 525H554L380 263L556 0H391L293 199H276L180 0Z" fill="#1B1A17" />
        <path transform="translate(16.03 40.64) scale(0.02563 -0.02563)" d="M116 -13Q69 -13 45.5 7.0Q22 27 22 69Q22 112 45.5 132.0Q69 152 116 152Q164 152 187.5 132.0Q211 112 211 69Q211 -13 116 -13Z" fill="#0F5C4D" />
        <path transform="translate(22.00 40.64) scale(0.02563 -0.02563)" d="M359 -14Q287 -14 230.0 8.5Q173 31 132.5 74.5Q92 118 70.5 181.5Q49 245 49 327Q49 444 90.0 520.5Q131 597 202.5 635.5Q274 674 364 674Q434 674 491.0 651.5Q548 629 588.5 585.5Q629 542 651.0 477.5Q673 413 673 330Q673 245 651.0 181.0Q629 117 587.5 73.5Q546 30 488.0 8.0Q430 -14 359 -14ZM363 101Q416 101 452.0 127.0Q488 153 507.0 202.0Q526 251 526 322Q526 396 506.5 448.0Q487 500 450.0 527.5Q413 555 360 555Q308 555 271.5 528.5Q235 502 215.5 452.0Q196 402 196 328Q196 274 207.5 231.5Q219 189 240.0 160.0Q261 131 292.0 116.0Q323 101 363 101Z" fill="#0F5C4D" />
        <path transform="translate(40.50 40.64) scale(0.02563 -0.02563)" d="M328 -14Q263 -14 211.5 -1.5Q160 11 123.5 36.5Q87 62 66.5 100.5Q46 139 43 189L169 230Q171 185 191.5 155.0Q212 125 250.0 111.0Q288 97 335 97Q380 97 411.0 108.0Q442 119 458.0 137.5Q474 156 474 178Q474 204 454.0 220.0Q434 236 399.5 247.0Q365 258 321 268Q272 279 224.5 293.0Q177 307 138.5 329.0Q100 351 77.5 386.0Q55 421 55 474Q55 535 85.5 579.5Q116 624 175.0 649.0Q234 674 317 674Q401 674 460.5 649.5Q520 625 553.0 580.5Q586 536 589 475L459 439Q459 470 449.0 493.0Q439 516 421.0 531.5Q403 547 376.5 555.0Q350 563 316 563Q277 563 248.5 553.0Q220 543 205.5 526.0Q191 509 191 486Q191 459 213.5 441.5Q236 424 273.5 413.0Q311 402 356 392Q399 383 443.5 369.5Q488 356 526.5 334.5Q565 313 588.5 276.5Q612 240 612 185Q612 125 580.0 80.0Q548 35 484.5 10.5Q421 -14 328 -14Z" fill="#0F5C4D" />
      </svg>
    ),
    { ...size },
  );
}
