import localFont from 'next/font/local';

// Tiempos Headline / anthropicSerif (display font)
export const tiemposHeadline = localFont({
    src: [
        {
            path: '../../public/fonts/75014e9053556df0-s.p.woff2',
            weight: '300 800',
            style: 'normal',
        },
        {
            path: '../../public/fonts/06fe80d45fc12f7f-s.p.woff2',
            weight: '300 800',
            style: 'italic',
        },
    ],
    variable: '--font-display',
    display: 'swap',
});

// Styrene / anthropicSans (UI font)
export const styreneA = localFont({
    src: [
        {
            path: '../../public/fonts/0cd27f4e808e3c8d-s.p.woff2',
            weight: '300 800',
            style: 'normal',
        },
        {
            path: '../../public/fonts/b5f39ee185750359-s.p.woff2',
            weight: '300 800',
            style: 'italic',
        },
    ],
    variable: '--font-ui',
    display: 'swap',
});

// Same as UI font (antropicSans is used for both)
export const styreneB = localFont({
    src: [
        {
            path: '../../public/fonts/0cd27f4e808e3c8d-s.p.woff2',
            weight: '300 800',
            style: 'normal',
        },
        {
            path: '../../public/fonts/b5f39ee185750359-s.p.woff2',
            weight: '300 800',
            style: 'italic',
        },
    ],
    variable: '--font-sans',
    display: 'swap',
});

// OpenDyslexic (accessibility font, used for claude-response variable)
export const claudeResponse = localFont({
    src: [
        {
            path: '../../public/fonts/b96accb76593e50d-s.p.woff2',
            weight: '400',
            style: 'normal',
        },
        {
            path: '../../public/fonts/a72997480c14a9d4-s.p.woff2',
            weight: '500',
            style: 'normal',
        },
        {
            path: '../../public/fonts/a0eafab536ffd221-s.p.woff2',
            weight: '500',
            style: 'italic',
        },
    ],
    variable: '--font-claude-response',
    display: 'swap',
});
