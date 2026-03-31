(function(){try{if(typeof document<`u`){var e=document.createElement(`style`);e.appendChild(document.createTextNode(`.chessboard-container{aspect-ratio:1;justify-content:center;align-items:center;width:100%;height:100%;display:flex}.chessboard{contain:strict;touch-action:none;background:conic-gradient(var(--dark-sq) 90deg, var(--light-sq) 90deg 180deg, var(--dark-sq) 180deg 270deg, var(--light-sq) 270deg) top left / 25% 25%;border-radius:2px;position:relative;overflow:hidden;box-shadow:0 2px 10px #0000004d}.chess-square{contain:layout style;position:absolute}.chess-square.light{background-color:var(--light-sq)}.chess-square.dark{background-color:var(--dark-sq)}.chess-square.light.last-move{background-color:var(--last-move-light)}.chess-square.dark.last-move{background-color:var(--last-move-dark)}.selection-highlight{background-color:var(--selected-sq);z-index:1;position:absolute;inset:0}.check-highlight{z-index:1;background:radial-gradient(red 0%,#e70000 25%,#a9000000 89%,#9e000000 100%);position:absolute;inset:0}.chess-piece{z-index:2;background-position:50%;background-repeat:no-repeat;background-size:cover;position:absolute;inset:0}.dragging-piece{pointer-events:none}.legal-move-dot{background:var(--legal-move-dot);z-index:3;pointer-events:none;position:absolute;inset:0}.legal-move-capture{background:var(--legal-move-capture);z-index:3;pointer-events:none;position:absolute;inset:0}.coord-label{pointer-events:none;-webkit-user-select:none;user-select:none}.arrow-layer{pointer-events:none}.resize-handle{opacity:0;transition:opacity .15s}.resize-handle:hover,.resize-handle:active{opacity:1}.resize-handle:before,.resize-handle:after{content:"";background:#fff9;border-radius:1px;position:absolute}.resize-handle:before{width:12px;height:2px;bottom:5px;right:3px;transform:rotate(-45deg)}.resize-handle:after{width:7px;height:2px;bottom:3px;right:1px;transform:rotate(-45deg)}
/*$vite$:1*/`)),document.head.appendChild(e)}}catch(e){console.error(`vite-plugin-css-injected-by-js`,e)}})();import { memo as e, useCallback as t, useEffect as n, useLayoutEffect as r, useMemo as i, useRef as a, useState as o } from "react";
import { jsx as s, jsxs as c } from "react/jsx-runtime";
//#region src/components/PieceSvgs.ts
var l = {};
function u(e) {
	return `data:image/svg+xml,${encodeURIComponent(e)}`;
}
var d = {
	wk: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill=\"none\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path stroke-linejoin=\"miter\" d=\"M22.5 11.63V6M20 8h5\"/><path fill=\"#fff\" stroke-linecap=\"butt\" stroke-linejoin=\"miter\" d=\"M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5\"/><path fill=\"#fff\" d=\"M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10z\"/><path d=\"M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0\"/></g></svg>"),
	wq: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill=\"#fff\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path d=\"M8 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0m16.5-4.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0M41 12a2 2 0 1 1-4 0 2 2 0 1 1 4 0M16 8.5a2 2 0 1 1-4 0 2 2 0 1 1 4 0M33 9a2 2 0 1 1-4 0 2 2 0 1 1 4 0\"/><path stroke-linecap=\"butt\" d=\"M9 26c8.5-1.5 21-1.5 27 0l2-12-7 11V11l-5.5 13.5-3-15-3 15-5.5-14V25L7 14z\"/><path stroke-linecap=\"butt\" d=\"M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z\"/><path fill=\"none\" d=\"M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0\"/></g></svg>"),
	wr: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill=\"#fff\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path stroke-linecap=\"butt\" d=\"M9 39h27v-3H9zm3-3v-4h21v4zm-1-22V9h4v2h5V9h5v2h5V9h4v5\"/><path d=\"m34 14-3 3H14l-3-3\"/><path stroke-linecap=\"butt\" stroke-linejoin=\"miter\" d=\"M31 17v12.5H14V17\"/><path d=\"m31 29.5 1.5 2.5h-20l1.5-2.5\"/><path fill=\"none\" stroke-linejoin=\"miter\" d=\"M11 14h23\"/></g></svg>"),
	wb: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill=\"none\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><g fill=\"#fff\" stroke-linecap=\"butt\"><path d=\"M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.35.49-2.32.47-3-.5 1.35-1.94 3-2 3-2z\"/><path d=\"M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z\"/><path d=\"M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z\"/></g><path stroke-linejoin=\"miter\" d=\"M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5\"/></g></svg>"),
	wn: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill=\"none\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path fill=\"#fff\" d=\"M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21\"/><path fill=\"#fff\" d=\"M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.042-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4.003 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.994-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.992 2.5-3c1 0 1 3 1 3\"/><path fill=\"#000\" d=\"M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0m5.433-9.75a.5 1.5 30 1 1-.866-.5.5 1.5 30 1 1 .866.5\"/></g></svg>"),
	wp: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><path fill=\"#fff\" stroke=\"#000\" stroke-linecap=\"round\" stroke-width=\"1.5\" d=\"M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47 1.47-1.19 2.41-3 2.41-5.03 0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z\"/></svg>"),
	bk: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill=\"none\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path stroke-linejoin=\"miter\" d=\"M22.5 11.6V6\"/><path fill=\"#000\" stroke-linecap=\"butt\" stroke-linejoin=\"miter\" d=\"M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5\"/><path fill=\"#000\" d=\"M11.5 37a22.3 22.3 0 0 0 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10z\"/><path stroke-linejoin=\"miter\" d=\"M20 8h5\"/><path stroke=\"#ececec\" d=\"M32 29.5s8.5-4 6-9.7C34.1 14 25 18 22.5 24.6v2.1-2.1C20 18 9.9 14 7 19.9c-2.5 5.6 4.8 9 4.8 9\"/><path stroke=\"#ececec\" d=\"M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0\"/></g></svg>"),
	bq: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><g stroke=\"none\"><circle cx=\"6\" cy=\"12\" r=\"2.75\"/><circle cx=\"14\" cy=\"9\" r=\"2.75\"/><circle cx=\"22.5\" cy=\"8\" r=\"2.75\"/><circle cx=\"31\" cy=\"9\" r=\"2.75\"/><circle cx=\"39\" cy=\"12\" r=\"2.75\"/></g><path stroke-linecap=\"butt\" d=\"M9 26c8.5-1.5 21-1.5 27 0l2.5-12.5L31 25l-.3-14.1-5.2 13.6-3-14.5-3 14.5-5.2-13.6L14 25 6.5 13.5z\"/><path stroke-linecap=\"butt\" d=\"M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z\"/><path fill=\"none\" stroke-linecap=\"butt\" d=\"M11 38.5a35 35 1 0 0 23 0\"/><path fill=\"none\" stroke=\"#ececec\" d=\"M11 29a35 35 1 0 1 23 0m-21.5 2.5h20m-21 3a35 35 1 0 0 22 0m-23 3a35 35 1 0 0 24 0\"/></g></svg>"),
	br: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path stroke-linecap=\"butt\" d=\"M9 39h27v-3H9zm3.5-7 1.5-2.5h17l1.5 2.5zm-.5 4v-4h21v4z\"/><path stroke-linecap=\"butt\" stroke-linejoin=\"miter\" d=\"M14 29.5v-13h17v13z\"/><path stroke-linecap=\"butt\" d=\"M14 16.5 11 14h23l-3 2.5zM11 14V9h4v2h5V9h5v2h5V9h4v5z\"/><path fill=\"none\" stroke=\"#ececec\" stroke-linejoin=\"miter\" stroke-width=\"1\" d=\"M12 35.5h21m-20-4h19m-18-2h17m-17-13h17M11 14h23\"/></g></svg>"),
	bb: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill=\"none\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><g fill=\"#000\" stroke-linecap=\"butt\"><path d=\"M9 36c3.4-1 10.1.4 13.5-2 3.4 2.4 10.1 1 13.5 2 0 0 1.6.5 3 2-.7 1-1.6 1-3 .5-3.4-1-10.1.5-13.5-1-3.4 1.5-10.1 0-13.5 1-1.4.5-2.3.5-3-.5 1.4-2 3-2 3-2z\"/><path d=\"M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z\"/><path d=\"M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z\"/></g><path stroke=\"#ececec\" stroke-linejoin=\"miter\" d=\"M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5\"/></g></svg>"),
	bn: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><g fill=\"none\" fill-rule=\"evenodd\" stroke=\"#000\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path fill=\"#000\" d=\"M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21\"/><path fill=\"#000\" d=\"M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.04-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-1-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-2 2.5-3c1 0 1 3 1 3\"/><path fill=\"#ececec\" stroke=\"#ececec\" d=\"M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0m5.43-9.75a.5 1.5 30 1 1-.86-.5.5 1.5 30 1 1 .86.5\"/><path fill=\"#ececec\" stroke=\"none\" d=\"m24.55 10.4-.45 1.45.5.15c3.15 1 5.65 2.49 7.9 6.75S35.75 29.06 35.25 39l-.05.5h2.25l.05-.5c.5-10.06-.88-16.85-3.25-21.34s-5.79-6.64-9.19-7.16z\"/></g></svg>"),
	bp: u("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 45 45\"><path stroke=\"#000\" stroke-linecap=\"round\" stroke-width=\"1.5\" d=\"M22.5 9a4 4 0 0 0-3.22 6.38 6.48 6.48 0 0 0-.87 10.65c-3 1.06-7.41 5.55-7.41 13.47h23c0-7.92-4.41-12.41-7.41-13.47a6.46 6.46 0 0 0-.87-10.65A4.01 4.01 0 0 0 22.5 9z\"/></svg>")
}, f = {
	wk: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linecap=\"round\" stroke-width=\"1.2\" d=\"M27.67 15.22v-3.54h4.44V7.25h-4.93V3.36H22.8v3.9h-4.93v4.42h4.44v3.55\"/><rect width=\"9.4\" height=\"2.79\" x=\"20.3\" y=\"14.21\" fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linejoin=\"round\" stroke-width=\"1.2\" ry=\"1.39\"/><path d=\"M26.42 14.21c.72 0 1.3.63 1.3 1.4s-.58 1.4-1.3 1.4h1.97c.72 0 1.3-.63 1.3-1.4s-.58-1.4-1.3-1.4z\" opacity=\".15\"/><path fill=\"#fff\" d=\"M21.63 14.84c-.4 0-.72.35-.72.78 0 .42.32.77.72.77h.88c-.4 0-.73-.35-.73-.78 0-.42.32-.77.72-.77z\"/><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linecap=\"round\" stroke-width=\"1.2\" d=\"M33.63 36.99s7.78-13.32 6.62-15.92c-1.17-2.6-8.48-4.5-15.25-4.5s-14.08 1.9-15.25 4.5c-1.16 2.6 6.61 15.92 6.61 15.92z\"/><path d=\"M25 16.58c15.93 2.62 12.57 9.35 6.64 22.54l2.02-1.73s7.75-13.72 6.59-16.32c-1.55-2.83-7.5-4.16-15.25-4.5z\" opacity=\".15\"/><path fill=\"#fff\" d=\"M23.77 17.3c-3.9-.19-14.63 1.8-13.5 5.01.8 3.73 2.75 7.25 4.5 10.5-5.69-10.33-5.94-13.77 9-15.52z\"/><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.46s-9.13.04-11.7 1.62c-1.72 1.06-2.13 3.65-1.9 6.32h27.2c.23-2.67-.18-5.26-1.9-6.32C34.12 36.5 25 36.46 25 36.46z\"/><path fill=\"#fff\" d=\"M25 37.15S16.29 37 13.38 38.8c-.37.23-.7.84-.96 1.4.26-.34.5-.62.89-.86C15.87 37.78 25 37.73 25 37.73s9.13.05 11.7 1.62c.38.24.58.54.85.87a3 3 0 0 0-1.15-1.6C33.65 37.15 25 37.16 25 37.16z\"/></svg>"),
	wq: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M24.959 5.094a2.958 3.316 90 0 0-3.316 2.958 2.958 3.316 90 0 0 3.316 2.959 2.958 3.316 90 0 0 3.316-2.959 2.958 3.316 90 0 0-3.316-2.958\"/><path fill=\"#fff\" d=\"M24.836 5.732c-.376-.21-3.724.806-2.185 3.576-.235-1.545.438-3.203 2.185-3.576\"/><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M24.959 11.011c-6.507 0-9.595 5.884-9.595 10.358h19.263c0-4.474-3.16-10.358-9.668-10.358\"/><path fill=\"#fff\" d=\"M18.161 14.977c1.042-1.478 2.92-3.22 6.84-3.38-.31.277-4.788 1.138-6.84 3.38\"/><path d=\"M24.836 5.007s.046.238 0 0c2.48 1.129 2.05 3.847.817 5.547 7.354 3.803 2.213 8.669 2.212 8.668h2.701c1.762 1.287 7.209-2.741-3.835-8.67 3.528-3.115.097-5.606-1.895-5.546z\" opacity=\".15\"/><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 15.225c-1.971 0-2.348 2.65-4.137 2.86-1.82.213-3.381-2.312-5.25-1.737-1.495.46-.778 2.6-1.805 3.175-1.402.785-3.185-1.832-5.29-.298 6.838 8.829 8.085 12.377 7.983 18.819h16.998c-.103-6.443 1.144-9.99 7.983-18.82-2.106-1.533-3.889 1.084-5.29.3-1.027-.576-.311-2.716-1.806-3.176-1.868-.575-3.429 1.95-5.25 1.736-1.789-.21-2.166-2.86-4.137-2.86z\"/><path fill=\"#fff\" d=\"M9.895 19.34c-.136-.01-.331.056-.458.085 3.081 4.1 6.575 9.537 7.099 12.417-1.407-4.933-3.267-9.562-6.14-12.472z\"/><path d=\"M39.974 18.735c-9.485 10.003-9.924 17.985-16.941 19.31h10.476c-.103-6.443 1.145-9.99 7.983-18.819 0 0-.688-.756-1.518-.491\" opacity=\".15\"/><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.457s-9.13.048-11.691 1.62c-1.727 1.06-2.135 3.65-1.9 6.323h27.182c.235-2.672-.172-5.264-1.9-6.324-2.56-1.571-11.69-1.62-11.69-1.62z\"/><path fill=\"#fff\" d=\"M25 37.147s-8.712-.137-11.624 1.666c-.37.229-.7.84-.954 1.39.261-.331.502-.613.887-.849C15.869 37.783 25 37.734 25 37.734s9.132.049 11.692 1.62c.391.24.593.532.856.87.026-.076-.409-1.158-1.144-1.596C33.648 37.136 25 37.147 25 37.147\"/></svg>"),
	wr: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-width=\"1.2\" d=\"M17.93 20.41c4.9-.74 9.58-.57 14.14 0M14.18 9.66c-1.06 8.77 1.1 10.68 3.75 10.75l-3.31 18.16h20.76l-3.31-18.16c2.64-.07 4.8-1.98 3.75-10.75l-3.61-.53-1.07 3.65-3.15-.1-.52-3.76h-4.94L22 12.68l-3.15.1-1.07-3.65z\"/><path d=\"M17.93 20.41c6.83 0 13.12.41 14.95 16.58l2.32.38-3.13-16.43c-.03-.3-6.09-1.82-14.14-.53\" opacity=\".15\"/><path fill=\"#fff\" d=\"m14.78 10.22 2.27-.29c-1.91.32-2.3 5.3-2.3 5.3-.25-.18-.2-4.9.03-5.01m10.5-.67c-1.65 0-2.52 2.75-2.52 2.75l.33-2.73zm7.4.27.92.11c-.78.5-1.59 2-1.59 2zm-14.2 11.14 2.61-.29c-2.62.3-4.89 13.11-4.89 13.11z\"/><path d=\"M34.01 9.4c.36 6.36-1.95 10.6-8.04 10.53l4.78.57c7.52.3 5.1-10.8 5.07-10.84z\" opacity=\".15\"/><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.46s-9.13.04-11.7 1.62c-1.72 1.06-2.13 3.65-1.9 6.32h27.2c.23-2.67-.18-5.26-1.9-6.32C34.12 36.5 25 36.46 25 36.46z\"/><path fill=\"#fff\" d=\"M25 37.15S16.29 37 13.38 38.8c-.37.23-.7.84-.96 1.4.26-.34.5-.62.89-.86C15.87 37.78 25 37.73 25 37.73s9.13.05 11.7 1.62c.38.24.58.53.85.87a3 3 0 0 0-1.15-1.6C33.65 37.15 25 37.16 25 37.16z\"/></svg>"),
	wb: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 5.77c-2.1 0-3.81.88-3.81 1.96l1.51 2.65C6.65 24.47 17 37.52 17 37.52h16s7.05-8.68.77-19.51l-3 4.82c-.66 1.09-1.96 1.5-2.9.91-.93-.57-1.14-1.91-.47-3l3.89-6.27a35.38 35.38 0 0 0-4-4.09l1.52-2.65c0-1.08-1.7-1.96-3.8-1.96z\"/><path d=\"M25 5.77c-.82 0-1.57.13-2.2.36 4.35.84 4.99 1.12 2.57 4.35l3.24 3.56c-3.65 8.24-1.6 8-1.6 8s.7-2.65 4.11-7.77a35.7 35.7 0 0 0-3.82-3.89l1.51-2.65c0-1.08-1.7-1.96-3.81-1.96M33.77 18l-1.01 1.52c3.73 8.41-4.14 18-4.14 18H33c.16.03 6.96-8.85.77-19.52\" opacity=\".15\"/><path fill=\"#fff\" d=\"M15.14 31.72c-.22-.03-3.42-9.78 5.76-18.75-2.3 1.9-7.14 13.16-5.75 18.75zM23.3 10.2l-1.47-2.6s.24-.72 1.78-1.05c-1.73 1.35-1 1.67-.3 3.65z\"/><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.46s-9.13.04-11.7 1.62c-1.72 1.06-2.13 3.65-1.9 6.32h27.2c.23-2.67-.18-5.26-1.9-6.32C34.12 36.5 25 36.46 25 36.46z\"/><path fill=\"#fff\" d=\"M25 37.15S16.29 37 13.38 38.8c-.37.23-.7.84-.96 1.4.26-.34.5-.62.89-.86 2.56-1.56 11.69-1.6 11.69-1.6s9.13.04 11.7 1.61c.38.24.58.54.85.87a3 3 0 0 0-1.15-1.6C33.65 37.15 25 37.16 25 37.16z\"/></svg>"),
	wn: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"-1.5 0 50 50\"><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25.192 23.015c-.1654 6.9672-11.758 5.2189-11.516 18.104l22.86.1184c-2.094-6.442 9.69-25.16-11.931-32.258v-.0001s-2.4381-2.601-5.9655-2.8237l.2227 3.5347-4.5583 4.5816c-2.6294 3.1455-8.7347 8.3784-7.7513 9.6111 3.1158 5.3041 6.3306 4.4316 6.3306 4.4316 4.2418-4.5433 5.8193-2.0894 12.309-5.2997z\"/><path d=\"M19.32 14.694c-.7757.8609-.6902 1.1156-.8137 2.1503.8055.1232 1.5069.2398 2.2486.0656 2.3809-1.262.075-3.4026-1.4347-2.2162z\" opacity=\".35\" paint-order=\"fill markers stroke\"/><path d=\"M9.1916 22.166c-.8496.4078-.9984.9608-1.0565 1.4754.7288.4181 1.8765-.1255 2.0412-1.4316l-.9846-.044z\" opacity=\".3\"/><path fill=\"#fff\" d=\"M8.1905 25.15s.6525 1.1374-1.1019-1.641c.6594-1.9774 8.263-9.0796 12.438-13.534l-.1836-3.0857s1.0689 1.6901 1.2475 3.468c-4.3898 4.39-12.22 10.833-12.824 13.213.023.6738.24 1.0278.4231 1.5797z\"/><path d=\"M13.26 28.257c2.0291-3.3367 8.3914-3.2239 11.932-5.2424.3228.1024.1304 1.3697.2398 1.23.8476-1.0903 2.9259-3.279.8684-6.8743.5214 5.9575-13.718 5.5912-15.89 10.305-.2005.4355 2.1818.7932 2.85.5818z\" opacity=\".15\"/><path fill=\"#fff\" d=\"M25.8 23.781c-1.0131 5.8132-9.5449 6.1169-10.988 12.641 2.8332-6.4058 10.762-5.7136 10.988-12.641\"/><path d=\"M18.64 6.1556s3.051.738 4.9045 3.9825c20.499 7.1536 7.6413 27.937 5.7883 31.073l7.2034.026c-1.9871-3.2431 9.5482-25.597-11.931-32.258-1.7757-1.0691-2.7677-2.6092-5.9655-2.8238z\" opacity=\".15\"/><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.457s-9.1309.048-11.691 1.6192c-1.7273 1.0602-2.1348 3.6514-1.8998 6.3237h27.182c.235-2.6723-.1725-5.2636-1.8999-6.3237-2.5597-1.5711-11.691-1.6192-11.691-1.6192z\"/><path fill=\"#fff\" d=\"M25 37.147s-8.7121-.1373-11.624 1.6658c-.3698.2291-.6992.8394-.9536 1.3902.2608-.3313.5022-.613.8867-.849 2.5598-1.5711 11.691-1.6191 11.691-1.6191s9.1318.048 11.692 1.6191c.391.24.5924.5316.8556.8701.026-.076-.4084-1.1578-1.1438-1.5962-2.7554-1.492-11.403-1.4808-11.403-1.4808z\"/></svg>"),
	wp: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#f0f0f0\" stroke=\"#3c3c3c\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M21.503 27.594h6.994M19 17.508a6.35 6.35 0 0 0 1.966 4.587l-3.65 2.1.43 3.399h4.306c-.794 3.559-2.755 7.33-5.062 8.617s-5.3 3.097-4.843 8.189h25.706c.457-5.092-2.535-6.902-4.842-8.189-2.307-1.286-4.268-5.058-5.062-8.617h4.306l.43-3.4-3.65-2.099a6.352 6.352 0 0 0 1.966-4.587c0-3.367-2.628-5.912-6-5.912-3.373 0-6.002 2.545-6.001 5.912z\"/><path d=\"M24.962 11.537c1.17-.459 9.527 5.906.647 10.773l4.512 2.1-.562 3.125h2.659l.428-3.399-3.65-2.1c1.253-1.2 1.962-2.58 1.964-4.312-.468-5.416-5.998-6.186-5.998-6.186zm-2.949 15.998c4.503 7.934 9.47 9.994 13.074 9.965l-2.115-1.347c-2.075-1.49-4.732-4.858-5.062-8.618z\" opacity=\".15\"/><path fill=\"#fff\" d=\"m21.983 22.213-1.647 2.347-2.356-.014 4.013-2.324zm2.324-9.946c-2.542.138-5.73 3.173-4.385 6.918l.199.643c-.33-3.489 2.127-7.116 4.186-7.561m-6.444 25.358c-3.984 2.305-5.117 6.14-5.117 6.14-.01 0-.548-4.175 3.956-6.654s4.822-6.15 5.86-8.893c-.636 3.704-.715 7.102-4.699 9.407\"/></svg>"),
	bk: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linecap=\"round\" stroke-width=\"1.2\" d=\"M27.67 15.22v-3.54h4.44V7.25h-4.93V3.36H22.8v3.9h-4.93v4.42h4.44v3.55\"/><rect width=\"9.4\" height=\"2.79\" x=\"20.3\" y=\"14.21\" fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linejoin=\"round\" stroke-width=\"1.2\" ry=\"1.39\"/><path d=\"M26.42 14.21c.72 0 1.3.63 1.3 1.4s-.58 1.4-1.3 1.4h1.97c.72 0 1.3-.63 1.3-1.4s-.58-1.4-1.3-1.4z\" opacity=\".18\"/><path fill=\"#fff\" d=\"M21.63 14.84c-.4 0-.72.35-.72.78 0 .42.32.77.72.77h.88c-.4 0-.73-.35-.73-.78 0-.42.32-.77.72-.77z\" opacity=\".25\"/><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linecap=\"round\" stroke-width=\"1.2\" d=\"M33.63 36.99s7.78-13.32 6.62-15.92c-1.17-2.6-8.48-4.5-15.25-4.5s-14.08 1.9-15.25 4.5c-1.16 2.6 6.61 15.92 6.61 15.92z\"/><path d=\"M25 16.58c15.93 2.62 12.57 9.35 6.64 22.54l2.02-1.73s7.75-13.72 6.59-16.32c-1.55-2.83-7.5-4.16-15.25-4.5z\" opacity=\".18\"/><path fill=\"#fff\" d=\"M23.77 17.3c-3.9-.19-14.63 1.8-13.5 5.01.8 3.73 2.75 7.25 4.5 10.5-5.69-10.33-5.94-13.77 9-15.52z\" opacity=\".25\"/><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.46s-9.13.04-11.7 1.62c-1.72 1.06-2.13 3.65-1.9 6.32h27.2c.23-2.67-.18-5.26-1.9-6.32C34.12 36.5 25 36.46 25 36.46z\"/><path fill=\"#fff\" d=\"M25 37.15S16.29 37 13.38 38.8c-.37.23-.7.84-.96 1.4.26-.34.5-.62.89-.86C15.87 37.78 25 37.73 25 37.73s9.13.05 11.7 1.62c.38.24.58.54.85.87a3 3 0 0 0-1.15-1.6C33.65 37.15 25 37.16 25 37.16z\" opacity=\".25\"/></svg>"),
	bq: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M24.959 5.094a2.958 3.316 90 0 0-3.316 2.958 2.958 3.316 90 0 0 3.316 2.959 2.958 3.316 90 0 0 3.316-2.959 2.958 3.316 90 0 0-3.316-2.958\"/><path fill=\"#fff\" d=\"M24.836 5.732c-.376-.21-3.724.806-2.185 3.576-.235-1.545.438-3.203 2.185-3.576\" opacity=\".25\"/><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M24.959 11.011c-6.507 0-9.595 5.884-9.595 10.358h19.263c0-4.474-3.16-10.358-9.668-10.358\"/><path fill=\"#fff\" d=\"M18.161 14.977c1.042-1.478 2.92-3.22 6.84-3.38-.31.277-4.788 1.138-6.84 3.38\" opacity=\".25\"/><path d=\"M24.836 5.007s.046.238 0 0c2.48 1.129 2.05 3.847.817 5.547 7.354 3.803 2.213 8.669 2.212 8.668h2.701c1.762 1.287 7.209-2.741-3.835-8.67 3.528-3.115.097-5.606-1.895-5.546z\" opacity=\".18\"/><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 15.225c-1.971 0-2.348 2.65-4.137 2.86-1.82.213-3.381-2.312-5.25-1.737-1.495.46-.778 2.6-1.805 3.175-1.402.785-3.185-1.832-5.29-.298 6.838 8.829 8.085 12.377 7.983 18.819h16.998c-.103-6.443 1.144-9.99 7.983-18.82-2.106-1.533-3.889 1.084-5.29.3-1.027-.576-.311-2.716-1.806-3.176-1.868-.575-3.429 1.95-5.25 1.736-1.789-.21-2.166-2.86-4.137-2.86z\"/><path fill=\"#fff\" d=\"M9.895 19.34c-.136-.01-.331.056-.458.085 3.081 4.1 6.575 9.537 7.099 12.417-1.407-4.933-3.267-9.562-6.14-12.472z\" opacity=\".25\"/><path d=\"M39.974 18.735c-9.485 10.003-9.924 17.985-16.941 19.31h10.476c-.103-6.443 1.145-9.99 7.983-18.819 0 0-.688-.756-1.518-.491\" opacity=\".18\"/><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.457s-9.13.048-11.691 1.62c-1.727 1.06-2.135 3.65-1.9 6.323h27.182c.235-2.672-.172-5.264-1.9-6.324-2.56-1.571-11.69-1.62-11.69-1.62z\"/><path fill=\"#fff\" d=\"M25 37.147s-8.712-.137-11.624 1.666c-.37.229-.7.84-.954 1.39.261-.331.502-.613.887-.849C15.869 37.783 25 37.734 25 37.734s9.132.049 11.692 1.62c.391.24.593.532.856.87.026-.076-.409-1.158-1.144-1.596C33.648 37.136 25 37.147 25 37.147\" opacity=\".25\"/></svg>"),
	br: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-width=\"1.2\" d=\"M17.93 20.41c4.9-.74 9.58-.57 14.14 0M14.18 9.66c-1.06 8.77 1.1 10.68 3.75 10.75l-3.31 18.16h20.76l-3.31-18.16c2.64-.07 4.8-1.98 3.75-10.75l-3.61-.53-1.07 3.65-3.15-.1-.52-3.76h-4.94L22 12.68l-3.15.1-1.07-3.65z\"/><path d=\"M17.93 20.41c6.83 0 13.12.41 14.95 16.58l2.32.38-3.13-16.43c-.03-.3-6.09-1.82-14.14-.53\" opacity=\".18\"/><path fill=\"#fff\" d=\"m14.78 10.22 2.27-.29c-1.91.32-2.3 5.3-2.3 5.3-.25-.18-.2-4.9.03-5.01m10.5-.67c-1.65 0-2.52 2.75-2.52 2.75l.33-2.73zm7.4.27.92.11c-.78.5-1.59 2-1.59 2zm-14.2 11.14 2.61-.29c-2.62.3-4.9 13.05-4.9 13.11z\" opacity=\".25\"/><path d=\"M34.01 9.4c.36 6.36-1.95 10.6-8.04 10.53l4.78.57c7.52.3 5.1-10.8 5.07-10.84z\" opacity=\".18\"/><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.46s-9.13.04-11.7 1.62c-1.72 1.06-2.13 3.65-1.9 6.32h27.2c.23-2.67-.18-5.26-1.9-6.32C34.12 36.5 25 36.46 25 36.46z\"/><path fill=\"#fff\" d=\"M25 37.15S16.29 37 13.38 38.8c-.37.23-.7.84-.96 1.4.26-.34.5-.62.89-.86C15.87 37.78 25 37.73 25 37.73s9.13.05 11.7 1.62c.38.24.58.53.85.87a3 3 0 0 0-1.15-1.6C33.65 37.15 25 37.16 25 37.16z\" opacity=\".25\"/></svg>"),
	bb: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 5.77c-2.1 0-3.81.88-3.81 1.96l1.51 2.65C6.65 24.47 17 37.52 17 37.52h16s7.05-8.68.77-19.51l-3 4.82c-.66 1.09-1.96 1.5-2.9.91-.93-.57-1.14-1.91-.47-3l3.89-6.27a35.38 35.38 0 0 0-4-4.09l1.52-2.65c0-1.08-1.7-1.96-3.8-1.96z\"/><path d=\"M25 5.77c-.82 0-1.57.13-2.2.36 4.35.84 4.99 1.12 2.57 4.35l3.24 3.56c-3.65 8.24-1.6 8-1.6 8s.7-2.65 4.11-7.77a35.7 35.7 0 0 0-3.82-3.89l1.51-2.65c0-1.08-1.7-1.96-3.81-1.96M33.77 18l-1.01 1.52c3.73 8.41-4.14 18-4.14 18H33c.16.03 6.96-8.85.77-19.52\" opacity=\".18\"/><path fill=\"#fff\" d=\"M15.14 31.72c-.22-.03-3.42-9.78 5.76-18.75-2.3 1.9-7.14 13.16-5.75 18.75zM23.3 10.2l-1.47-2.6s.24-.72 1.78-1.05c-1.73 1.35-1 1.67-.3 3.65z\" opacity=\".25\"/><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.46s-9.13.04-11.7 1.62c-1.72 1.06-2.13 3.65-1.9 6.32h27.2c.23-2.67-.18-5.26-1.9-6.32C34.12 36.5 25 36.46 25 36.46z\"/><path fill=\"#fff\" d=\"M25 37.15S16.29 37 13.38 38.8c-.37.23-.7.84-.96 1.4.26-.34.5-.62.89-.86 2.56-1.56 11.69-1.6 11.69-1.6s9.13.04 11.7 1.61c.38.24.58.54.85.87a3 3 0 0 0-1.15-1.6C33.65 37.15 25 37.16 25 37.16z\" opacity=\".25\"/></svg>"),
	bn: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"-1.5 0 50 50\"><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25.192 23.015c-.1654 6.9672-11.758 5.2189-11.516 18.104l22.86.1184c-2.094-6.442 9.69-25.16-11.931-32.258v-.0001s-2.4381-2.601-5.9655-2.8237l.2227 3.5347-4.5583 4.5816c-2.6294 3.1455-8.7347 8.3784-7.7513 9.6111 3.1158 5.3041 6.3306 4.4316 6.3306 4.4316 4.2418-4.5433 5.8193-2.0894 12.309-5.2997z\"/><path d=\"M19.32 14.694c-.7757.8609-.6902 1.1156-.8137 2.1503.8055.1232 1.5069.2398 2.2486.0656 2.3809-1.262.075-3.4026-1.4347-2.2162z\" opacity=\".4\" paint-order=\"fill markers stroke\"/><path d=\"M9.1916 22.166c-.8496.4078-.9984.9608-1.0565 1.4754.7288.4181 1.8765-.1255 2.0412-1.4316l-.9846-.044z\" opacity=\".35\"/><path fill=\"#fff\" d=\"M8.1905 25.15s.6525 1.1374-1.1019-1.641c.6594-1.9774 8.263-9.0796 12.438-13.534l-.1836-3.0857s1.0689 1.6901 1.2475 3.468c-4.3898 4.39-12.22 10.833-12.824 13.213.023.6738.24 1.0278.4231 1.5797z\" opacity=\".25\"/><path d=\"M13.26 28.257c2.0291-3.3367 8.3914-3.2239 11.932-5.2424.3228.1024.1304 1.3697.2398 1.23.8476-1.0903 2.9259-3.279.8684-6.8743.5214 5.9575-13.718 5.5912-15.89 10.305-.2005.4355 2.1818.7932 2.85.5818z\" opacity=\".18\"/><path fill=\"#fff\" d=\"M25.8 23.781c-1.0131 5.8132-9.5449 6.1169-10.988 12.641 2.8332-6.4058 10.762-5.7136 10.988-12.641\" opacity=\".25\"/><path d=\"M18.64 6.1556s3.051.738 4.9045 3.9825c20.499 7.1536 7.6413 27.937 5.7883 31.073l7.2034.026c-1.9871-3.2431 9.5482-25.597-11.931-32.258-1.7757-1.0691-2.7677-2.6092-5.9655-2.8238z\" opacity=\".18\"/><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M25 36.457s-9.1309.048-11.691 1.6192c-1.7273 1.0602-2.1348 3.6514-1.8998 6.3237h27.182c.235-2.6723-.1725-5.2636-1.8999-6.3237-2.5597-1.5711-11.691-1.6192-11.691-1.6192z\"/><path fill=\"#fff\" d=\"M25 37.147s-8.7121-.1373-11.624 1.6658c-.3698.2291-.6992.8394-.9536 1.3902.2608-.3313.5022-.613.8867-.849 2.5598-1.5711 11.691-1.6191 11.691-1.6191s9.1318.048 11.692 1.6191c.391.24.5924.5316.8556.8701.026-.076-.4084-1.1578-1.1438-1.5962-2.7554-1.492-11.403-1.4808-11.403-1.4808z\" opacity=\".25\"/></svg>"),
	bp: u("<svg xmlns=\"http://www.w3.org/2000/svg\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" image-rendering=\"optimizeQuality\" shape-rendering=\"geometricPrecision\" text-rendering=\"geometricPrecision\" viewBox=\"0 0 50 50\"><path fill=\"#5f5955\" stroke=\"#1e1e1e\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M21.503 27.594h6.994M19 17.508a6.35 6.35 0 0 0 1.966 4.587l-3.65 2.1.43 3.399h4.306c-.794 3.559-2.755 7.33-5.062 8.617s-5.3 3.097-4.843 8.189h25.706c.457-5.092-2.535-6.902-4.842-8.189-2.307-1.286-4.268-5.058-5.062-8.617h4.306l.43-3.4-3.65-2.099a6.352 6.352 0 0 0 1.966-4.587c0-3.367-2.628-5.912-6-5.912-3.373 0-6.002 2.545-6.001 5.912z\"/><path d=\"M24.962 11.537c1.17-.459 9.527 5.906.647 10.773l4.512 2.1-.562 3.125h2.659l.428-3.399-3.65-2.1c1.253-1.2 1.962-2.58 1.964-4.312-.468-5.416-5.998-6.186-5.998-6.186zm-2.949 15.998c4.503 7.934 9.47 9.994 13.074 9.965l-2.115-1.347c-2.075-1.49-4.732-4.858-5.062-8.618z\" opacity=\".18\"/><path fill=\"#fff\" d=\"m21.983 22.213-1.647 2.347-2.356-.014 4.013-2.324zm2.324-9.946c-2.542.138-5.73 3.173-4.385 6.918l.199.643c-.33-3.489 2.127-7.116 4.186-7.561m-6.444 25.358c-3.984 2.305-5.117 6.14-5.117 6.14-.01 0-.548-4.175 3.956-6.654s4.822-6.15 5.86-8.893c-.636 3.704-.715 7.102-4.699 9.407\" opacity=\".25\"/></svg>")
}, p = {
	lichess: d,
	"chess.com": f
};
function m(e, t, n = "lichess") {
	let r = `${n}:${e}${t}`;
	return l[r] || (l[r] = (p[n] || d)[`${e}${t}`] || ""), l[r];
}
function h(e = "lichess") {
	let t = p[e] || d;
	return Object.values(t);
}
//#endregion
//#region src/components/ChessBoard.tsx
function ee(e) {
	let t = /* @__PURE__ */ new Map(), n = e.split(" ")[0].split("/");
	for (let e = 0; e < 8; e++) {
		let r = 0;
		for (let i of n[e]) if (i >= "1" && i <= "8") r += parseInt(i);
		else {
			let n = i === i.toUpperCase() ? "w" : "b", a = i.toLowerCase(), o = `${String.fromCharCode(97 + r)}${8 - e}`;
			t.set(o, {
				type: a,
				color: n
			}), r++;
		}
	}
	return t;
}
var g = /* @__PURE__ */ new Set(), _ = {
	green: 0,
	red: 1,
	blue: 2,
	yellow: 3
}, v = {
	green: 2,
	red: 1,
	blue: 3,
	yellow: 0
}, y = {
	0: "green",
	1: "red",
	2: "blue",
	3: "yellow"
}, b = {
	0: "yellow",
	1: "red",
	2: "green",
	3: "blue"
};
function te(e, t, n) {
	let r = n === "chess.com" ? b : y, i = [];
	for (let t of e) i.push({
		color: r[t.brush] ?? "green",
		from: t.from,
		to: t.to
	});
	for (let e of t) i.push({
		color: r[e.brush] ?? "green",
		from: e.square
	});
	return i;
}
function x(e) {
	return (e.shiftKey || e.ctrlKey ? 1 : 0) + (e.altKey ? 2 : 0);
}
function S(e) {
	return e.altKey ? 3 : e.shiftKey ? 2 : e.ctrlKey ? 1 : 0;
}
function C(e, t) {
	return e === "chess.com" ? S(t) : x(t);
}
var w = {
	arrow: [
		"#15781B",
		"#882020",
		"#003088",
		"#e68f00"
	],
	highlight: [
		"#15781B",
		"#882020",
		"#003088",
		"#e68f00"
	],
	arrowOpacity: .6,
	highlightOpacity: 1,
	liveArrowOpacity: .6,
	highlightStyle: "circle",
	arrowStyle: "line"
}, T = {
	arrow: [
		"rgba(255,170,0,0.8)",
		"rgba(248,85,63,0.8)",
		"rgba(159,207,63,0.8)",
		"rgba(72,193,249,0.8)"
	],
	highlight: [
		"rgb(235,97,80)",
		"rgb(255,170,0)",
		"rgb(172,206,89)",
		"rgb(82,176,220)"
	],
	arrowOpacity: .8,
	highlightOpacity: .8,
	liveArrowOpacity: 0,
	highlightStyle: "square",
	arrowStyle: "polygon"
}, E = {
	lightSquare: "#f0d9b5",
	darkSquare: "#b58863",
	lastMoveLight: "#cdd16a",
	lastMoveDark: "#aaa23a",
	selectedLight: "rgba(20, 85, 30, 0.5)",
	selectedDark: "rgba(20, 85, 30, 0.5)",
	legalMoveDot: "rgba(20, 85, 30, 0.5)",
	legalMoveCapture: "rgba(20, 85, 0, 0.3)",
	coordLight: "#f0d9b5",
	coordDark: "#946f51"
}, D = {
	lightSquare: "#ebecd0",
	darkSquare: "#739552",
	lastMoveLight: "#f5f682",
	lastMoveDark: "#b9ca43",
	selectedLight: "rgba(20, 85, 30, 0.5)",
	selectedDark: "rgba(20, 85, 30, 0.5)",
	legalMoveDot: "rgba(0, 0, 0, 0.1)",
	legalMoveCapture: "rgba(0, 0, 0, 0.1)",
	coordLight: "#ebecd0",
	coordDark: "#6a8a3f"
};
function O(e) {
	return e === "chess.com" ? T : w;
}
function ne(e) {
	return e === "chess.com" ? D : E;
}
var re = [
	"a",
	"b",
	"c",
	"d",
	"e",
	"f",
	"g",
	"h"
], ie = [
	"8",
	"7",
	"6",
	"5",
	"4",
	"3",
	"2",
	"1"
];
function ae(e) {
	return [e.charCodeAt(0) - 97, parseInt(e[1]) - 1];
}
function oe(e, t) {
	return `${String.fromCharCode(97 + e)}${t + 1}`;
}
function se(e, t) {
	return (e + t) % 2 != 0;
}
function ce(e, t) {
	let [n, r] = ae(e), [i, a] = ae(t), o = Math.abs(i - n), s = Math.abs(a - r);
	return o === 1 && s === 2 || o === 2 && s === 1;
}
function le(e, t, n, r, i) {
	let a = n - e, o = r - t, s = Math.sqrt(a * a + o * o);
	if (s === 0) return "";
	let c = a / s, l = o / s, u = -l, d = c, f = i * .11, p = i * .26, m = i * .36, h = n, ee = r, g = n - c * m, _ = r - l * m, v = e + c * m, y = t + l * m;
	return [
		[v + u * f, y + d * f],
		[g + u * f, _ + d * f],
		[g + u * p, _ + d * p],
		[h, ee],
		[g - u * p, _ - d * p],
		[g - u * f, _ - d * f],
		[v - u * f, y - d * f]
	].map(([e, t]) => `${e},${t}`).join(" ");
}
function ue(e, t, n, r, i) {
	let a = n - e, o = r - t, s = Math.abs(o) > Math.abs(a), c = i * .11, l = i * .26, u = i * .36, d, f;
	s ? (d = e, f = r) : (d = n, f = t);
	let p = n - d, m = r - f, h = Math.sqrt(p * p + m * m);
	if (h === 0) return le(e, t, n, r, i);
	let ee = p / h, g = m / h, _ = -g, v = ee, y = d - e, b = f - t, te = Math.sqrt(y * y + b * b);
	if (te === 0) return le(e, t, n, r, i);
	let x = y / te, S = b / te, C = -S, w = x, T = n, E = r, D = n - ee * u, O = r - g * u, ne = e + x * u, re = t + S * u;
	return [
		[ne + C * c, re + w * c],
		[d + C * c, f + w * c],
		[d + C * c + _ * c, f + w * c + v * c],
		[D + _ * c, O + v * c],
		[D + _ * l, O + v * l],
		[T, E],
		[D - _ * l, O - v * l],
		[D - _ * c, O - v * c],
		[d - _ * c, f - v * c],
		[d - C * c - _ * c, f - w * c - v * c],
		[d - C * c, f - w * c],
		[ne - C * c, re - w * c]
	].map(([e, t]) => `${e},${t}`).join(" ");
}
var de = e(function({ square: e, x: t, y: n, size: r, piece: i, isSelected: a, isDragSource: o, isLegalMove: l, isCapture: u, isLastMoveSquare: d, isCheck: f, isLight: p, drawingMode: h, interactive: ee, onSquareClick: g }) {
	return /* @__PURE__ */ c("div", {
		className: `chess-square${d ? " last-move" : ""}${p ? " light" : " dark"}`,
		"data-square": e,
		style: {
			left: t,
			top: n,
			width: r,
			height: r
		},
		onClick: () => g(e),
		children: [
			a && /* @__PURE__ */ s("div", { className: "selection-highlight" }),
			f && /* @__PURE__ */ s("div", { className: "check-highlight" }),
			i && !o && /* @__PURE__ */ s("div", {
				className: "chess-piece",
				"data-piece": `${i.color}${i.type}`,
				style: {
					backgroundImage: `url("${m(i.color, i.type, h)}")`,
					cursor: ee ? "pointer" : "default"
				}
			}),
			l && !u && /* @__PURE__ */ s("div", { className: "legal-move-dot" }),
			u && /* @__PURE__ */ s("div", { className: "legal-move-capture" })
		]
	});
});
function k({ fen: e, orientation: l = "white", onMove: u, interactive: d = !0, width: f, drawingMode: p = "lichess", resizable: y = !1, turnColor: b, legalMoves: x, lastMove: S, check: w, annotations: T, onAnnotationsChange: E, clearAnnotationsOnClick: D = !0 }) {
	let k = i(() => ee(e), [e]), fe = (b ?? "white") === "white" ? "w" : "b", [A, j] = o(null), [M, N] = o(g), [P, pe] = o([]), [F, me] = o([]), he = a([]), ge = a([]);
	n(() => {
		he.current = P;
	}, [P]), n(() => {
		ge.current = F;
	}, [F]);
	let [_e, I] = o(null), L = a(null), [ve, R] = o(null), z = a(null), B = a(null), V = a(null), ye = a(null), H = a(null), U = a(null), W = a(null), G = a(null), K = a(null), q = a(0), be = a(() => {}), xe = a(u);
	n(() => {
		xe.current = u;
	}, [u]);
	let Se = a(x);
	n(() => {
		Se.current = x;
	}, [x]);
	let Ce = a(E);
	n(() => {
		Ce.current = E;
	}, [E]);
	let we = a(p);
	n(() => {
		we.current = p;
	}, [p]);
	let Te = a(D);
	n(() => {
		Te.current = D;
	}, [D]);
	let Ee = a(null), De = a(null), Oe = a(!1), ke = a(!1), Ae = a(!1), je = a(!1), Me = a(""), [Ne, Pe] = o(void 0), J = Ne ?? f, [Fe, Ie] = o(J || 0), Y = i(() => O(p), [p]), X = i(() => ne(p), [p]), Le = i(() => {
		if (!T) return [];
		let e = p === "chess.com" ? v : _;
		return T.filter((e) => e.to != null).map((t) => ({
			from: t.from,
			to: t.to,
			color: Y.arrow[e[t.color] ?? 0],
			brush: e[t.color] ?? 0
		}));
	}, [
		T,
		p,
		Y
	]), Re = i(() => {
		if (!T) return [];
		let e = p === "chess.com" ? v : _;
		return T.filter((e) => e.to == null).map((t) => ({
			square: t.from,
			color: Y.highlight[e[t.color] ?? 0],
			brush: e[t.color] ?? 0
		}));
	}, [
		T,
		p,
		Y
	]);
	n(() => {
		if (!Oe.current) {
			Oe.current = !0;
			return;
		}
		Ce.current?.(te(P, F, we.current));
	}, [P, F]), n(() => {
		if (J) {
			Ie(J);
			return;
		}
		let e = ye.current;
		if (!e) return;
		let t = new ResizeObserver((e) => {
			for (let t of e) {
				let { width: e, height: n } = t.contentRect;
				Ie(Math.min(e, n));
			}
		});
		t.observe(e);
		let n = e.getBoundingClientRect();
		return Ie(Math.min(n.width, n.height)), () => t.disconnect();
	}, [J]), n(() => {
		for (let e of h(p)) {
			let t = new Image();
			t.src = e;
		}
	}, [p]), r(() => {
		if (!je.current) {
			je.current = !0, Me.current = S ? `${S.from}${S.to}` : "";
			return;
		}
		let e = S ? `${S.from}${S.to}` : "";
		if (e === Me.current || !S || !V.current) {
			Me.current = e;
			return;
		}
		if (Me.current = e, Ae.current) {
			Ae.current = !1;
			return;
		}
		let t = V.current.querySelector(`[data-square="${S.to}"]`), n = t?.querySelector(".chess-piece");
		if (!t || !n) return;
		let r = De.current, i = r(S.from), a = r(S.to), o = i.x - a.x, s = i.y - a.y;
		if (o === 0 && s === 0) return;
		t.style.contain = "none", t.style.zIndex = "10";
		let c = n.animate([{ transform: `translate(${o}px, ${s}px)` }, { transform: "translate(0, 0)" }], {
			duration: 250,
			easing: "cubic-bezier(0.5, 0, 0.5, 1)"
		});
		c.onfinish = () => {
			t.style.contain = "", t.style.zIndex = "";
		};
	}, [S, e]);
	let Z = Math.floor(Fe / 8), Q = Z * 8, ze = t((e) => {
		let t = V.current;
		if (!t) return null;
		let n = G.current ?? t.getBoundingClientRect(), r = e.clientX - n.left, i = e.clientY - n.top;
		if (r < 0 || i < 0 || r >= n.width || i >= n.height) return null;
		let a = n.width / 8, o = Math.floor(r / a), s = 7 - Math.floor(i / a);
		return l === "black" && (o = 7 - o, s = 7 - s), o < 0 || o > 7 || s < 0 || s > 7 ? null : oe(o, s);
	}, [l]), $ = t((e) => {
		let [t, n] = ae(e);
		return l === "white" ? {
			x: t * Z,
			y: (7 - n) * Z
		} : {
			x: (7 - t) * Z,
			y: n * Z
		};
	}, [l, Z]);
	n(() => {
		Ee.current = ze;
	}, [ze]), n(() => {
		De.current = $;
	}, [$]);
	let Be = t((e) => {
		if (!d) return;
		if (ke.current) {
			ke.current = !1;
			return;
		}
		if (D && (he.current.length > 0 && pe([]), ge.current.length > 0 && me([])), A) {
			if (A === e) {
				j(null), N(g);
				return;
			}
			if (M.has(e)) {
				u?.(A, e), j(null), N(g);
				return;
			}
		}
		let t = k.get(e);
		t && t.color === fe ? (j(e), N(new Set(x?.get(e) ?? []))) : (j(null), N(g));
	}, [
		d,
		A,
		M,
		k,
		fe,
		u,
		x,
		D
	]);
	n(() => {
		be.current = Be;
	}, [Be]);
	let Ve = t((e) => be.current(e), []), He = t((e) => {
		let t = e.pointerType === "touch";
		if (K.current !== null && e.pointerId !== K.current) return;
		if (e.button === 2) {
			if (t) return;
			if (e.preventDefault(), L.current) {
				let e = L.current.from;
				if (L.current = null, G.current = null, I(null), j(null), N(g), H.current && (H.current.style.display = "none"), V.current) {
					let t = V.current.querySelector(`[data-square="${e}"] .chess-piece`);
					t && (t.style.visibility = "visible");
				}
				if (K.current !== null) {
					try {
						V.current?.releasePointerCapture(K.current);
					} catch {}
					K.current = null;
				}
				return;
			}
			if (A !== null && (j(null), N(g), p === "lichess")) return;
			let n = ze(e);
			if (n) {
				z.current = {
					from: n,
					brush: C(p, e)
				}, B.current = n, V.current && (G.current = V.current.getBoundingClientRect()), R(n), K.current = e.pointerId, q.current = e.buttons;
				try {
					V.current?.setPointerCapture(e.pointerId);
				} catch {}
			}
			return;
		}
		if (e.button !== 0 || !d) return;
		if (t && (ke.current = !0), z.current && (z.current = null, B.current = null, G.current = null, R(null), U.current && (U.current.style.display = "none"), W.current && (W.current.style.display = "none"), K.current !== null)) {
			try {
				V.current?.releasePointerCapture(K.current);
			} catch {}
			K.current = null;
		}
		let n = ze(e);
		if (!n) return;
		let r = k.get(n);
		if (A && M.has(n)) {
			Te.current && (he.current.length > 0 && pe([]), ge.current.length > 0 && me([])), u?.(A, n), j(null), N(g);
			return;
		}
		if (Te.current && (he.current.length > 0 && pe([]), ge.current.length > 0 && me([])), r && r.color === fe) {
			if (t && A === n) {
				j(null), N(g);
				return;
			}
			if (L.current = {
				piece: r.type,
				color: r.color,
				from: n
			}, H.current && V.current) {
				let t = V.current.getBoundingClientRect();
				G.current = t;
				let i = e.clientX - t.left - Z / 2, a = e.clientY - t.top - Z / 2;
				H.current.style.transform = `translate(${i}px, ${a}px)`, H.current.style.backgroundImage = `url("${m(r.color, r.type, p)}")`, H.current.style.display = "block";
				let o = V.current.querySelector(`[data-square="${n}"] .chess-piece`);
				o && (o.style.visibility = "hidden");
			}
			I(n), j(n), N(new Set(x?.get(n) ?? [])), K.current = e.pointerId, q.current = e.buttons;
			try {
				V.current?.setPointerCapture(e.pointerId);
			} catch {}
		} else t && A && (j(null), N(g));
	}, [
		d,
		k,
		fe,
		ze,
		A,
		M,
		u,
		x,
		Z,
		p
	]);
	n(() => {
		let e = (e) => {
			if (K.current !== null && e.pointerId !== K.current) return;
			let t = q.current, n = e.buttons;
			if (q.current = n, L.current && !(t & 2) && n & 2) {
				let e = L.current.from;
				if (L.current = null, G.current = null, I(null), j(null), N(g), H.current && (H.current.style.display = "none"), V.current) {
					let t = V.current.querySelector(`[data-square="${e}"] .chess-piece`);
					t && (t.style.visibility = "visible");
				}
				if (K.current !== null) {
					try {
						V.current?.releasePointerCapture(K.current);
					} catch {}
					K.current = null;
				}
				q.current = 0;
				return;
			}
			if (z.current && !(t & 1) && n & 1) {
				if (z.current = null, B.current = null, G.current = null, R(null), U.current && (U.current.style.display = "none"), W.current && (W.current.style.display = "none"), K.current !== null) {
					try {
						V.current?.releasePointerCapture(K.current);
					} catch {}
					K.current = null;
				}
				q.current = 0;
				return;
			}
			if (L.current && H.current) {
				let t = G.current;
				if (!t) return;
				let n = t.width / 8, r = e.clientX - t.left - n / 2, i = e.clientY - t.top - n / 2;
				H.current.style.transform = `translate(${r}px, ${i}px)`;
			}
			if (z.current) {
				let t = Ee.current(e);
				B.current = t;
				let n = !t || t === z.current.from, r = z.current.brush, i = Y.arrow[r], a = De.current, o = G.current, s = o ? o.width / 8 : 0, c = a(z.current.from), l = c.x + s / 2, u = c.y + s / 2, d, f;
				if (t && !n) {
					let e = a(t);
					d = e.x + s / 2, f = e.y + s / 2;
				} else d = l, f = u;
				if (Y.arrowStyle === "line") {
					if (U.current && (U.current.style.display = n ? "none" : "inline", !n)) {
						let e = d - l, t = f - u, n = Math.sqrt(e * e + t * t), r = s * .156, a = n > 0 ? d - e / n * r : d, o = n > 0 ? f - t / n * r : f;
						U.current.setAttribute("x2", String(a)), U.current.setAttribute("y2", String(o)), U.current.setAttribute("stroke", i);
						let c = `arrowhead-${i.replace(/[^a-zA-Z0-9]/g, "")}`;
						U.current.setAttribute("marker-end", `url(#${c})`);
					}
				} else if (W.current) {
					if (Y.liveArrowOpacity === 0) W.current.style.display = "none";
					else if (W.current.style.display = n ? "none" : "inline", !n && t) {
						let e = ce(z.current.from, t) ? ue(l, u, d, f, s) : le(l, u, d, f, s);
						W.current.setAttribute("points", e), W.current.setAttribute("style", `fill: ${i}; opacity: ${Y.liveArrowOpacity};`);
					}
				}
			}
		}, t = (e) => {
			if (!(K.current !== null && e.pointerId !== K.current)) {
				if (L.current && e.button === 0) {
					let t = Ee.current(e);
					if (t && t !== L.current.from) {
						let e = L.current.from;
						(Se.current?.get(e) ?? []).includes(t) && (Ae.current = !0, xe.current?.(e, t), j(null), N(g));
					}
					L.current = null, G.current = null, I(null), H.current && (H.current.style.display = "none");
				}
				if (z.current && e.button === 2) {
					let t = z.current.from, n = z.current.brush, r = Y.arrow[n], i = Y.highlight[n], a = Ee.current(e);
					a && a !== t ? pe((e) => {
						let i = e.findIndex((e) => e.from === t && e.to === a);
						return i >= 0 ? e[i].brush === n ? e.filter((e, t) => t !== i) : e.map((e, t) => t === i ? {
							...e,
							color: r,
							brush: n
						} : e) : [...e, {
							from: t,
							to: a,
							color: r,
							brush: n
						}];
					}) : a === t && me((e) => {
						let t = e.findIndex((e) => e.square === a);
						return t >= 0 ? e[t].brush === n ? e.filter((e, n) => n !== t) : e.map((e, r) => r === t ? {
							...e,
							color: i,
							brush: n
						} : e) : [...e, {
							square: a,
							color: i,
							brush: n
						}];
					}), z.current = null, B.current = null, G.current = null, R(null), U.current && (U.current.style.display = "none"), W.current && (W.current.style.display = "none");
				}
				if (K.current !== null) {
					try {
						V.current?.releasePointerCapture(K.current);
					} catch {}
					K.current = null;
				}
				q.current = 0;
			}
		}, n = (e) => {
			if (!(K.current !== null && e.pointerId !== K.current)) {
				if (L.current) {
					let e = L.current.from;
					if (L.current = null, G.current = null, I(null), H.current && (H.current.style.display = "none"), V.current) {
						let t = V.current.querySelector(`[data-square="${e}"] .chess-piece`);
						t && (t.style.visibility = "visible");
					}
				}
				z.current && (z.current = null, B.current = null, G.current = null, R(null), U.current && (U.current.style.display = "none"), W.current && (W.current.style.display = "none")), K.current = null, q.current = 0;
			}
		};
		return window.addEventListener("pointermove", e, { passive: !0 }), window.addEventListener("pointerup", t), window.addEventListener("pointercancel", n), () => {
			window.removeEventListener("pointermove", e), window.removeEventListener("pointerup", t), window.removeEventListener("pointercancel", n);
		};
	}, [Y]);
	let Ue = t((e) => {
		e.preventDefault();
	}, []), We = i(() => {
		let e = [];
		for (let t of ie) for (let n of re) {
			let r = `${n}${t}`, i = se(n.charCodeAt(0) - 97, parseInt(t) - 1), a = $(r), o = A === r, c = M.has(r), l = k.get(r) ?? null, u = c && l != null, f = _e === r, m = !!(S && (S.from === r || S.to === r)), h = w === r;
			e.push(/* @__PURE__ */ s(de, {
				square: r,
				x: a.x,
				y: a.y,
				size: Z,
				piece: l,
				isSelected: o,
				isDragSource: f,
				isLegalMove: c,
				isCapture: u,
				isLastMoveSquare: m,
				isCheck: h,
				isLight: i,
				drawingMode: p,
				interactive: d,
				onSquareClick: Ve
			}, r));
		}
		return e;
	}, [
		k,
		Z,
		A,
		M,
		S,
		w,
		_e,
		$,
		Ve,
		d,
		p
	]), Ge = i(() => {
		let e = [], t = Math.max(10, Math.min(12, Z * .16)), n = l === "white" ? re : [...re].reverse(), r = l === "white" ? ie : [...ie].reverse();
		return n.forEach((n, r) => {
			let i = se(n.charCodeAt(0) - 97, l === "white" ? 0 : 7);
			e.push(/* @__PURE__ */ s("div", {
				className: "coord-label coord-file",
				style: {
					position: "absolute",
					left: r * Z + 4,
					bottom: 0,
					top: "auto",
					fontSize: t,
					fontWeight: 700,
					color: i ? X.coordDark : X.coordLight,
					pointerEvents: "none",
					zIndex: 4,
					lineHeight: 1,
					fontFamily: "\"Noto Sans\", sans-serif"
				},
				children: n
			}, `file-${n}`));
		}), r.forEach((n, r) => {
			let i = parseInt(n) - 1, a = se(l === "white" ? 7 : 0, i);
			e.push(/* @__PURE__ */ s("div", {
				className: "coord-label coord-rank",
				style: {
					position: "absolute",
					right: 0,
					left: "auto",
					top: r * Z + 1,
					fontSize: t,
					fontWeight: 700,
					color: a ? X.coordDark : X.coordLight,
					pointerEvents: "none",
					zIndex: 4,
					lineHeight: 1,
					fontFamily: "\"Noto Sans\", sans-serif"
				},
				children: n
			}, `rank-${n}`));
		}), e;
	}, [
		l,
		Z,
		X
	]), Ke = i(() => {
		let e = (e) => {
			let t = $(e);
			return {
				x: t.x + Z / 2,
				y: t.y + Z / 2
			};
		}, t = {
			x: 0,
			y: 0
		};
		ve && (t = e(ve));
		let n = [...P, ...Le], r = [...F, ...Re], i = new Set(n.map((e) => Y.arrow[e.brush] ?? e.color));
		for (let e of Y.arrow) i.add(e);
		let a = Y.arrowStyle === "polygon";
		return /* @__PURE__ */ c("svg", {
			className: "arrow-layer",
			style: {
				position: "absolute",
				inset: 0,
				width: Q,
				height: Q,
				pointerEvents: "none",
				zIndex: 10
			},
			children: [
				!a && /* @__PURE__ */ s("defs", { children: Array.from(i).map((e, t) => /* @__PURE__ */ s("marker", {
					id: `arrowhead-${e.replace(/[^a-zA-Z0-9]/g, "")}`,
					markerWidth: "4",
					markerHeight: "4",
					refX: "2.05",
					refY: "2",
					orient: "auto",
					overflow: "visible",
					children: /* @__PURE__ */ s("path", {
						d: "M0,0 V4 L3,2 Z",
						fill: e
					})
				}, `marker-${t}`)) }),
				Y.highlightStyle === "circle" ? r.map((t) => {
					let n = e(t.square), r = Y.highlight[t.brush] ?? t.color, i = Z * .0625, a = Z / 2 - i / 2;
					return /* @__PURE__ */ s("circle", {
						className: "square-highlight",
						cx: n.x,
						cy: n.y,
						r: a,
						fill: "none",
						stroke: r,
						strokeWidth: i,
						opacity: Y.highlightOpacity
					}, `highlight-${t.square}`);
				}) : null,
				n.map((t, n) => {
					let r = e(t.from), i = e(t.to), o = Y.arrow[t.brush] ?? t.color;
					if (a) {
						let e = ce(t.from, t.to) ? ue(r.x, r.y, i.x, i.y, Z) : le(r.x, r.y, i.x, i.y, Z);
						return /* @__PURE__ */ s("polygon", {
							className: "arrow",
							"data-arrow": `${t.from}${t.to}`,
							points: e,
							style: {
								fill: o,
								opacity: Y.arrowOpacity
							}
						}, `arrow-${n}`);
					}
					let c = i.x - r.x, l = i.y - r.y, u = Math.sqrt(c * c + l * l), d = Z * .156, f = i.x - c / u * d, p = i.y - l / u * d, m = `arrowhead-${o.replace(/[^a-zA-Z0-9]/g, "")}`;
					return /* @__PURE__ */ s("line", {
						x1: r.x,
						y1: r.y,
						x2: f,
						y2: p,
						stroke: o,
						strokeWidth: Z * .15625,
						strokeLinecap: "round",
						markerEnd: `url(#${m})`,
						opacity: Y.arrowOpacity
					}, `arrow-${n}`);
				}),
				!a && /* @__PURE__ */ s("line", {
					ref: U,
					x1: t.x,
					y1: t.y,
					x2: t.x,
					y2: t.y,
					stroke: Y.arrow[0],
					strokeWidth: Z * .15625 * .85,
					strokeLinecap: "round",
					markerEnd: `url(#arrowhead-${Y.arrow[0].replace(/[^a-zA-Z0-9]/g, "")})`,
					opacity: Y.liveArrowOpacity,
					display: "none"
				}),
				a && /* @__PURE__ */ s("polygon", {
					ref: W,
					points: "",
					style: {
						fill: Y.arrow[0],
						opacity: Y.liveArrowOpacity
					},
					display: "none"
				})
			]
		});
	}, [
		P,
		Le,
		ve,
		F,
		Re,
		$,
		Z,
		Q,
		Y
	]), qe = i(() => Y.highlightStyle === "square" ? [...F, ...Re].map((e) => {
		let t = $(e.square), n = Y.highlight[e.brush] ?? e.color;
		return /* @__PURE__ */ s("div", {
			className: "square-highlight",
			"data-highlight": e.square,
			style: {
				position: "absolute",
				left: t.x,
				top: t.y,
				width: Z,
				height: Z,
				backgroundColor: n,
				opacity: Y.highlightOpacity,
				pointerEvents: "none",
				zIndex: 9
			}
		}, `sq-highlight-${e.square}`);
	}) : null, [
		F,
		Re,
		$,
		Z,
		Y
	]), Je = a(null);
	n(() => () => {
		Je.current?.abort();
	}, []);
	let Ye = t((e) => {
		e.preventDefault(), e.stopPropagation(), Je.current?.abort();
		let t = new AbortController();
		Je.current = t;
		let n = e.clientX, r = e.clientY, i = Fe;
		window.addEventListener("mousemove", (e) => {
			let t = e.clientX - n, a = e.clientY - r;
			Pe(Math.max(200, i + Math.max(t, a)));
		}, { signal: t.signal }), window.addEventListener("mouseup", () => {
			t.abort();
		}, { signal: t.signal });
	}, [Fe]), Xe = i(() => ({
		position: "relative",
		width: Q,
		height: Q,
		userSelect: "none",
		"--light-sq": X.lightSquare,
		"--dark-sq": X.darkSquare,
		"--last-move-light": X.lastMoveLight,
		"--last-move-dark": X.lastMoveDark,
		"--selected-sq": X.selectedLight,
		"--legal-move-dot": `radial-gradient(${X.legalMoveDot} 19%, rgba(0,0,0,0) calc(20% + 1px))`,
		"--legal-move-capture": `radial-gradient(transparent 0%, transparent 79%, ${X.legalMoveCapture} calc(80% + 1px))`
	}), [Q, X]);
	return /* @__PURE__ */ s("div", {
		ref: ye,
		className: "chessboard-container",
		style: J ? {
			width: J,
			height: J
		} : void 0,
		children: /* @__PURE__ */ c("div", {
			ref: V,
			className: "chessboard",
			"data-testid": "chessboard",
			"data-drawing-mode": p,
			style: Xe,
			onPointerDown: He,
			onContextMenu: Ue,
			children: [
				We,
				Ge,
				qe,
				Ke,
				/* @__PURE__ */ s("div", {
					ref: H,
					className: "dragging-piece",
					style: {
						position: "absolute",
						left: 0,
						top: 0,
						display: "none",
						width: Z,
						height: Z,
						backgroundSize: "cover",
						pointerEvents: "none",
						zIndex: 100,
						willChange: "transform"
					}
				}),
				y && !f && /* @__PURE__ */ s("div", {
					className: "resize-handle",
					"data-testid": "resize-handle",
					onMouseDown: Ye,
					style: {
						position: "absolute",
						right: 0,
						bottom: 0,
						width: 22,
						height: 22,
						cursor: "nwse-resize",
						zIndex: 200
					}
				})
			]
		})
	});
}
//#endregion
export { k as ChessBoard };
