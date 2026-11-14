# Documentation

Five TYPO3 releases, from 2002 to 2017. 3.3.0 runs on PHP 4.4.9 and the rest
on PHP 5.6. There are two ways to run them.

- :lucide-app-window: [In your browser](browser/index.md): TYPO3 3.3.0 and 3.8.1 on PHP 4.4.9,
  compiled to WebAssembly. Nothing to install, and nothing leaves your tab.
- :fontawesome-brands-docker: [With Docker](docker/index.md): all five releases, each a compose file on
  your own machine.

| TYPO3 | Released | In your browser | With Docker |
| --- | --- | --- | --- |
| ![](assets/marks/mark1-blue-2002.png){ .mark } 3.3.0 | 2002-06-03 | [yes](browser/3.3.md) | [yes](docker/3.3.md) |
| ![](assets/marks/mark2-sheets-2003.png){ .mark } 3.8.1 | 2005-11-14 | [yes](browser/3.8.md) | [yes](docker/3.8.md) |
| ![](assets/marks/mark3-orange-green-4x.png){ .mark } 4.0.13 | 2009-07-02 | not yet | [yes](docker/4.0.md) |
| ![](assets/marks/mark4-orange-2012.png){ .mark } 4.5.40 | 2015-02-19 | not yet | [yes](docker/4.5.md) |
| ![](assets/marks/mark4-orange-2012.png){ .mark } 6.2.31 | 2017-04-18 | not yet | [yes](docker/6.2.md) |

!!! danger "Insecure by design"

    These releases and the PHP they run on carry years of known, unpatched
    remote code execution vulnerabilities. Never put real data in them.

    In your browser, they run inside your own tab, under a path of their own
    on this site.
    With Docker, run them on your own machine only. Never publish a port
    beyond `127.0.0.1`, and never run them on a server reachable from the
    internet. The compose files already bind to loopback and cut the
    application containers off from the network. Do not undo that.
