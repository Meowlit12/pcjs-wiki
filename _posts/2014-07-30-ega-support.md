---
layout: post
title: EGA Support
date: 2014-07-30 11:00:00
category: Video
permalink: /blog/2014/07/30/
---

PCjs v1.14.0 now includes basic EGA support.  It emulates the EGA hardware well enough to pass the IBM EGA BIOS
diagnostics and run [Windows 1.01](/devices/pcx86/machine/5160/ega/640kb/) in color.  Check out our
[Windows 1.01 "Server Array"](/devices/pcx86/machine/5160/ega/640kb/array/) demo.

[<img src="/blog/images/win101-array-demo-small.jpg" alt='Windows 1.01 "Server Array" Demo'/>](/blog/images/win101-array-demo.jpg)

EGA support is added to a **machine.xml** file using two XML elements; eg:

```xml
<video id="videoEGA" model="ega" memory="0x20000" screenwidth="640" screenheight="350"/>
```

The *model* attribute must be set to "ega" and the *memory* attribute should be set to the amount of memory
desired on the card; valid memory sizes are:
 
- 0x10000 (64Kb)
- 0x20000 (128Kb)
- 0x40000 (256Kb)

As with the MDA and CGA video cards, the *screenwidth* and *screenheight* attributes specify the size of display
window, which the browser will then scale up or down, unless a specific overall size has been specified on the
&lt;machine&gt; element.

The second required XML element is a &lt;rom&gt; element to load the EGA ROM; eg:

```xml
<rom id="romEGA" addr="0xc0000" size="0x4000" file="/devices/pcx86/video/ibm-ega.json" notify="videoEGA"/>
```

The *notify* attribute must match the *id* of the &lt;video&gt; element, so that the Video component can load
the initial 8x14 and 8x8 fonts from the ROM.  Support for dynamic loading of fonts from plane 2 of the EGA's memory
will be added later; however, current support works well enough to allow switching from 25-line mode to 43-line mode,
which essentially switches from the 8x14 font to the 8x8 font.

The &lt;video&gt; element also supports a *switches* attribute to specify the type of monitor connected to the EGA;
this attribute corresponds to the actual switch settings on the EGA card; our default *switches* setting is "0110",
which selects an Enhanced Color Monitor, enabling the EGA's maximum resolution of 640x350.

*[@jeffpar](http://twitter.com/jeffpar)*  
*July 30, 2014*
