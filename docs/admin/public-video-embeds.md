# Public video embeds

OpenLayerlyPro supports explicit public video embeds from YouTube, Vimeo, and Bilibili.

## Insert a video

In the Markdown editor, choose **Insert public video** and paste a supported HTTPS watch-page URL. The editor inserts a top-level directive:

```text
@video: https://www.youtube.com/watch?v=dQw4w9WgXcQ
```

The directive must be on its own unindented line. Similar text inside fenced code, inline code, blockquotes, lists, or indented code remains ordinary Markdown.

Authors cannot provide raw iframe HTML. Core validates the watch URL against the provider registry and generates a canonical iframe URL for one of these exact hosts:

- `www.youtube-nocookie.com`
- `player.vimeo.com`
- `player.bilibili.com`

No oEmbed request, title lookup, or thumbnail fetch is performed.

## Preview and privacy

The admin preview initially renders a placeholder and does not load a third-party player. A request to the provider is made only after the administrator selects **Load video**.

Published pages render the real provider iframe. Visitors may therefore disclose their IP address, browser information, and access time to the selected provider, and playback availability depends on that provider.

## Membership boundary

Third-party embeds are not members-only video delivery. Even when an embed appears in a members-only post, anyone who obtains the third-party video URL may be able to view it outside OpenLayerlyPro.

Use a self-hosted video attachment for content that requires membership-controlled byte access.
