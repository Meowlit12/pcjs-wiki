/**
 * @fileoverview This file implements the C1Pjs ROM component.
 * @author <a href="mailto:Jeff@pcjs.org">Jeff Parsons</a>
 * @copyright © 2012-2018 Jeff Parsons
 *
 * This file is part of PCjs, a computer emulation software project at <http://pcjs.org/>.
 *
 * PCjs is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * PCjs is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with PCjs.  If not,
 * see <http://www.gnu.org/licenses/gpl.html>.
 *
 * You are required to include the above copyright notice in every modified copy of this work
 * and to display that copyright notice when the software starts running; see COPYRIGHT in
 * <http://pcjs.org/modules/shared/lib/defines.js>.
 *
 * Some PCjs files also attempt to load external resource files, such as character-image files,
 * ROM files, and disk image files. Those external resource files are not considered part of PCjs
 * for purposes of the GNU General Public License, and the author does not claim any copyright
 * as to their contents.
 */

"use strict";

if (NODE) {
    var Str         = require("../../shared/lib/strlib");
    var Web         = require("../../shared/lib/weblib");
    var DumpAPI     = require("../../shared/lib/dumpapi");
    var Component   = require("../../shared/lib/component");
}

/**
 * TODO: The Closure Compiler treats ES6 classes as 'struct' rather than 'dict' by default,
 * which would force us to declare all class properties in the constructor, as well as prevent
 * us from defining any named properties.  So, for now, we mark all our classes as 'unrestricted'.
 *
 * @unrestricted
 */
class C1PROM extends Component {
    /**
     * C1PROM(parmsROM)
     *
     * The ROM component expects the following (parmsROM) properties:
     *
     *      size: amount of ROM, in bytes
     *      image: name of ROM image file
     *
     * NOTE: The final location for the ROM image, once loaded, will be specified
     * by the Computer object, using the setBuffer() method.
     *
     * @this {C1PROM}
     * @param {Object} parmsROM
     * @property {function()} convertImage
     */
    constructor(parmsROM)
    {
        super("C1PROM", parmsROM);

        this.abMem = null;
        this.abImage = null;
        this.cbROM = parmsROM['size'];
        this.sImage = parmsROM['image'];
        if (this.sImage) {
            var sFileURL = this.sImage;
            /**
             * If the selected ROM image has a ".json" extension, then we assume it's a pre-converted
             * JSON-encoded ROM image, so we load it as-is; ditto for files with a ".hex" extension. Otherwise,
             * we ask our server-side ROM image converter to return the corresponding JSON-encoded data,
             * in compact form (ie, minimal whitespace, no ASCII data comments, etc).
             */
            var sFileExt = Str.getExtension(this.sImage);
            if (sFileExt != DumpAPI.FORMAT.JSON && sFileExt != DumpAPI.FORMAT.HEX) {
                sFileURL = Web.getHost() + DumpAPI.ENDPOINT + '?' + DumpAPI.QUERY.FILE + '=' + this.sImage + '&' + DumpAPI.QUERY.FORMAT + '=' + DumpAPI.FORMAT.BYTES;
            }
            var rom = this;
            Web.getResource(sFileURL, null, true, function(sURL, sResponse, nErrorCode) {
                rom.convertImage(sURL, sResponse, nErrorCode);
            });
        }
    }

    /**
     * @this {C1PROM}
     * @param {Array} abMemory
     * @param {number} start
     * @param {number} end
     * @param {C1PCPU} cpu
     */
    setBuffer(abMemory, start, end, cpu)
    {
        this.abMem = abMemory;
        this.offROM = start;
        var cbROM = end - start + 1;
        /*
         * It's possible that the ROM component didn't specify a size,
         * in which case just use the size the Computer component has specified.
         */
        if (!this.cbROM)
            this.cbROM = cbROM;
        if (cbROM != this.cbROM) {
            this.setError("computer-specified ROM size (" + Str.toHexWord(cbROM) + ") does not match component-specified size (" + Str.toHexWord(this.cbROM) + ")");
            return;
        }
        if (cpu) {
            this.cpu = cpu;
            cpu.addWriteNotify(start, end, this, this.setByte);
        }
        this.copyImage();
    }

    /**
     * @this {C1PROM}
     * @param {boolean} fOn
     * @param {C1PComputer} cmp
     */
    setPower(fOn, cmp)
    {
        if (fOn && !this.flags.powered) {
            this.flags.powered = true;
            if (DEBUGGER) this.dbg = cmp.getComponentByType("debugger");
        }
    }

    /**
     * @this {C1PROM}
     * @param {number} addr
     * @param {number|undefined} [addrFrom]
     */
    setByte(addr, addrFrom)
    {
        /*
         * Beyond reporting this write, we need to "repair" the ROM, using the original image data,
         * but only if addrFrom is defined (undefined implies this is a write from the Debugger, and
         * we need to allow the Debugger to modify ROM contents).
         */
        if (addrFrom !== undefined) {
            if (DEBUGGER && this.dbg) this.dbg.messageIO(this, addr, addrFrom, this.dbg.MESSAGE_PORT, true);
            var offset = (addr - this.offROM);
            Component.assert(offset >= 0 && offset < this.cbROM);
            if (!this.abImage)
                this.abMem[this.offROM + offset] = 0;
            else
                this.abMem[this.offROM + offset] = this.abImage[offset];
        }
    }

    /**
     * @this {C1PROM}
     * @param {string} sImageName
     * @param {string} sImageData
     * @param {number} nErrorCode (response from server if anything other than 200)
     */
    convertImage(sImageName, sImageData, nErrorCode)
    {
        if (nErrorCode) {
            this.println("Error loading ROM \"" + sImageName + "\" (" + nErrorCode + ")");
            return;
        }
        if (sImageData.charAt(0) == "[" || sImageData.charAt(0) == "{") {
            try {
                /*
                 * The most likely source of any exception will be here: parsing the JSON-encoded ROM data.
                 */
                var rom = eval("(" + sImageData + ")");
                var ab = rom['bytes'];
                if (ab) {
                    this.abImage = ab;
                } else {
                    this.abImage = rom;
                }
            } catch (e) {
                this.println("Error processing ROM \"" + sImageName + "\": " + e.message);
                return;
            }
        }
        else {
            /*
             * Parse the ROM image data manually; we assume it's in "simplified" hex form (a series of hex byte-values separated by whitespace)
             */
            var sData = sImageData.replace(/\n/gm, " ").replace(/ +$/, "");
            var asData = sData.split(" ");
            this.abImage = new Array(asData.length);
            for (var i=0; i < asData.length; i++) {
                this.abImage[i] = parseInt(asData[i], 16);
            }
        }
        this.copyImage();
    }

    /**
     * @this {C1PROM}
     */
    copyImage()
    {
        /*
         * The Computer object may give us the address of the ROM image before we've finished downloading the image,
         * so both setBuffer() and convertImage() call copyImage(), which in turn will copy the image ONLY when both
         * pieces are in place.  At that point, the component becomes "ready", in much the same way that other components
         * (eg, CPU and Screen) become "ready" when all their prerequisites are satisfied.
         */
        if (!this.isReady()) {
            if (!this.sImage) {
                this.setReady();
            }
            else
            if (this.abImage && this.abMem) {
                var cbImage = this.abImage.length;
                if (cbImage != this.cbROM) {
                    this.setError("ROM image size (" + Str.toHexWord(cbImage) + ") does not match component-specified size (" + Str.toHexWord(this.cbROM) + ")");
                    return;
                }
                if (DEBUG) this.log("copyImage(): copying ROM to " + Str.toHexWord(this.offROM) + " (" + Str.toHexWord(cbImage) + " bytes)");
                for (var i=0; i < cbImage; i++) {
                    this.abMem[this.offROM + i] = this.abImage[i];
                }
                this.setReady();
            }
        }
    }

    /**
     * C1PROM.init()
     *
     * This function operates on every HTML element of class "rom", extracting the
     * JSON-encoded parameters for the C1PROM constructor from the element's "data-value"
     * attribute, invoking the constructor to create a C1PROM component, and then binding
     * any associated HTML controls to the new component.
     */
    static init()
    {
        var aeROM = Component.getElementsByClass(document, C1PJS.APPCLASS, "rom");
        for (var iROM=0; iROM < aeROM.length; iROM++) {
            var eROM = aeROM[iROM];
            var parmsROM = Component.getComponentParms(eROM);
            var rom = new C1PROM(parmsROM);
            Component.bindComponentControls(rom, eROM, C1PJS.APPCLASS);
        }
    }
}

/*
 * Initialize all the ROM modules on the page.
 */
Web.onInit(C1PROM.init);
