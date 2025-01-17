/**
 * @fileoverview Implements the PCx86 Bus component.
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
    var Usr         = require("../../shared/lib/usrlib");
    var Component   = require("../../shared/lib/component");
    var State       = require("../../shared/lib/state");
    var Memory      = require("./memory");
    var Messages    = require("./messages");
}

/**
 * Think of this Controller class definition as an interface definition, implemented by the
 * Video Card class and the RAM CompaqController class.
 * 
 * TODO: The Closure Compiler treats ES6 classes as 'struct' rather than 'dict' by default,
 * which would force us to declare all class properties in the constructor, as well as prevent
 * us from defining any named properties.  So, for now, we mark all our classes as 'unrestricted'.
 *
 * @unrestricted
 */
class Controller {
    /**
     * getMemoryAccess()
     *
     * @this {Controller}
     * @return {Array.<function()>}
     */
    getMemoryAccess()
    {
        return [];
    }
    
    /**
     * getMemoryBuffer(addr)
     *
     * @this {Controller}
     * @param {number} addr
     * @return {Array} containing the buffer (and an offset within that buffer)
     */
    getMemoryBuffer(addr)
    {
        return [];
    }
}

/**
 * TODO: The Closure Compiler treats ES6 classes as 'struct' rather than 'dict' by default,
 * which would force us to declare all class properties in the constructor, as well as prevent
 * us from defining any named properties.  So, for now, we mark all our classes as 'unrestricted'.
 *
 * @unrestricted
 */
class Bus extends Component {
    /**
     * Bus(cpu, dbg)
     *
     * The Bus component manages physical memory and I/O address spaces.
     *
     * The Bus component has no UI elements, so it does not require an init() handler,
     * but it still inherits from the Component class and must be allocated like any
     * other device component.  It's currently allocated by the Computer's init() handler,
     * which then calls the initBus() method of all the other components.
     *
     * When initMemory() initializes the entire address space, it also passes aMemBlocks
     * to the CPU object, so that the CPU can perform its own address-to-block calculations
     * (essential, for example, when the CPU enables paging).
     *
     * For memory beyond the simple needs of the ROM and RAM components (ie, memory-mapped
     * devices), the address space must still be allocated through the Bus component via
     * addMemory().  If the component needs something more than simple read/write storage,
     * it must provide a controller with getMemoryBuffer() and getMemoryAccess() methods.
     *
     * All port (I/O) operations are defined by external handlers; they register with us,
     * and we manage those registrations and provide support for I/O breakpoints, but the
     * only default I/O behavior we provide is ignoring writes to any unregistered output
     * ports and returning 0xff from any unregistered input ports.
     *
     * @this {Bus}
     * @param {Object} parmsBus
     * @param {X86CPU} cpu
     * @param {DebuggerX86} dbg
     */
    constructor(parmsBus, cpu, dbg)
    {
        super("Bus", parmsBus);

        this.cpu = cpu;
        this.dbg = dbg;

        this.nBusWidth = parmsBus['busWidth'] || 20;

        /*
         * Compute all Bus memory block parameters, based on the width of the bus.
         *
         * Regarding blockTotal, we want to avoid using block overflow expressions like:
         *
         *      iBlock < this.nBlockTotal? iBlock : 0
         *
         * As long as we know that blockTotal is a power of two (eg, 256 or 0x100, in the case of
         * nBusWidth == 20 and blockSize == 4096), we can define blockMask as (blockTotal - 1) and
         * rewrite the previous expression as:
         *
         *      iBlock & this.nBlockMask
         *
         * Similarly, we mask addresses with busMask to enforce "A20 wrap" on 20-bit buses.
         * For larger buses, A20 wrap can be simulated by either clearing bit 20 of busMask or by
         * changing all the block entries for the 2nd megabyte to match those in the 1st megabyte.
         *
         *      Bus Property        Old hard-coded values (when nBusWidth was always 20)
         *      ------------        ----------------------------------------------------
         *      this.nBusLimit      0xfffff
         *      this.nBusMask       [same as busLimit]
         *      this.nBlockSize     4096
         *      this.nBlockLen      (this.nBlockSize >> 2)
         *      this.nBlockShift    12
         *      this.nBlockLimit    0xfff
         *      this.nBlockTotal    ((this.nBusLimit + this.nBlockSize) / this.nBlockSize) | 0
         *      this.nBlockMask     (this.nBlockTotal - 1) [ie, 0xff]
         *
         * Note that we choose a nBlockShift value (and thus a physical memory block size) based on "buswidth":
         *
         *      Bus Width                       Block Shift     Block Size
         *      ---------                       -----------     ----------
         *      20 bits (1Mb address space):    12              4Kb (256 maximum blocks)
         *      24 bits (16Mb address space):   14              16Kb (1K maximum blocks)
         *      32 bits (4Gb address space);    15              32Kb (128K maximum blocks)
         *
         * The coarser block granularities (ie, 16Kb and 32Kb) may cause problems for certain RAM and/or ROM
         * allocations that are contiguous but are allocated out of order, or that have different controller
         * requirements.  Your choices, for the moment, are either to ensure the allocations are performed in
         * order, or to choose smaller nBlockShift values (at the expense of a generating a larger block array).
         *
         * Note that if PAGEBLOCKS is set, then for a bus width of 32 bits, the block size is fixed at 4Kb.
         */
        this.addrTotal = Math.pow(2, this.nBusWidth);
        this.nBusLimit = this.nBusMask = (this.addrTotal - 1) | 0;
        this.nBlockShift = (PAGEBLOCKS && this.nBusWidth == 32 || this.nBusWidth <= 20)? 12 : (this.nBusWidth <= 24? 14 : 15);
        this.nBlockSize = 1 << this.nBlockShift;
        this.nBlockLen = this.nBlockSize >> 2;
        this.nBlockLimit = this.nBlockSize - 1;
        this.nBlockTotal = (this.addrTotal / this.nBlockSize) | 0;
        this.nBlockMask = this.nBlockTotal - 1;
        this.assert(this.nBlockMask <= Bus.BlockInfo.num.mask);

        /*
         * Lists of I/O notification functions: aPortInputNotify and aPortOutputNotify are arrays, indexed by
         * port, of sub-arrays which contain:
         *
         *      [0]: registered function to call for every I/O access
         *
         * The registered function is called with the port address, and if the access was triggered by the CPU,
         * the linear instruction pointer (LIP) at the point of access.
         *
         * WARNING: Unlike the (old) read and write memory notification functions, these support only one
         * pair of input/output functions per port.  A more sophisticated architecture could support a list
         * of chained functions across multiple components, but I doubt that will be necessary here.
         *
         * UPDATE: The Debugger now piggy-backs on these arrays to indicate ports for which it wants notification
         * of I/O.  In those cases, the registered component/function elements may or may not be set, but the
         * following additional element will be set:
         *
         *      [1]: true to break on I/O, false to ignore I/O
         *
         * The false case is important if fPortInputBreakAll and/or fPortOutputBreakAll is set, because it allows the
         * Debugger to selectively ignore specific ports.
         */
        this.aPortInputNotify = [];
        this.aPortOutputNotify = [];
        this.fPortInputBreakAll = this.fPortOutputBreakAll = false;

        /*
         * By default, all I/O ports are 1 byte wide; ports that are wider must add themselves to one or both of
         * these lists, using addPortInputWidth() and/or addPortOutputWidth().
         */
        this.aPortInputWidth = [];
        this.aPortOutputWidth = [];

        /*
         * Allocate empty Memory blocks to span the entire physical address space.
         */
        this.initMemory();

        if (BACKTRACK) {
            this.abtObjects = [];
            this.cbtDeletions = 0;
            this.ibtLastAlloc = -1;
            this.ibtLastDelete = 0;
        }

        this.setReady();
    }

    /**
     * initMemory()
     *
     * Allocate enough (empty) Memory blocks to span the entire physical address space.
     *
     * @this {Bus}
     */
    initMemory()
    {
        var block = new Memory();
        block.copyBreakpoints(this.dbg);
        this.aMemBlocks = new Array(this.nBlockTotal);
        for (var iBlock = 0; iBlock < this.nBlockTotal; iBlock++) {
            this.aMemBlocks[iBlock] = block;
        }
        this.cpu.initMemory(this.aMemBlocks, this.nBlockShift);
        this.cpu.setAddressMask(this.nBusMask);
    }

    /**
     * reset()
     *
     * @this {Bus}
     */
    reset()
    {
        this.setA20(true);
        if (BACKTRACK) this.ibtLastDelete = 0;
    }

    /**
     * powerUp(data, fRepower)
     *
     * We don't need a powerDown() handler, because for largely historical reasons, our state (including the A20 state)
     * is saved by saveMemory(), which called by the CPU.
     *
     * However, we do need a powerUp() handler, because on resumable machines, the Computer's onReset() function calls
     * everyone's powerUp() handler rather than their reset() handler.
     *
     * TODO: Perhaps Computer should be smarter: if there's no powerUp() handler, then fallback to the reset() handler.
     * In that case, however, we'd either need to remove the powerUp() stub in Component, or detect the existence of the stub.
     *
     * @this {Bus}
     * @param {Object|null} data (always null because we supply no powerDown() handler)
     * @param {boolean} [fRepower]
     * @return {boolean} true if successful, false if failure
     */
    powerUp(data, fRepower)
    {
        if (!fRepower) this.reset();
        return true;
    }

    /**
     * addMemory(addr, size, type, controller)
     *
     * Adds new Memory blocks to the specified address range.  Any Memory blocks previously
     * added to that range must first be removed via removeMemory(); otherwise, you'll get
     * an allocation conflict error.  This helps prevent address calculation errors, redundant
     * allocations, etc.
     *
     * We've relaxed some of the original requirements (ie, that addresses must start at a
     * block-granular address, or that sizes must be equal to exactly one or more blocks),
     * because machines with large block sizes can make it impossible to load certain ROMs at
     * their required addresses.  Every allocation still allocates a whole number of blocks.
     *
     * Even so, Bus memory management does NOT provide a general-purpose heap.  Most memory
     * allocations occur during machine initialization and never change.  In particular, there
     * is NO support for removing partial-block allocations.  Typically, the only region that
     * changes post-initialization is the Video buffer, and only in the EGA/VGA implementation.
     *
     * Each Memory block keeps track of a start address (addr) and length (used), indicating
     * the used space within the block; any free space that precedes or follows that used space
     * can be allocated later, by simply extending the beginning or ending of the previously used
     * space.  However, any holes that might have existed between the original allocation and an
     * extension are subsumed by the extension.
     *
     * @this {Bus}
     * @param {number} addr is the starting physical address of the request
     * @param {number} size of the request, in bytes
     * @param {number} type is one of the Memory.TYPE constants
     * @param {Controller} [controller] is an optional memory controller component
     * @return {boolean} true if successful, false if not
     */
    addMemory(addr, size, type, controller)
    {
        var addrNext = addr;
        var sizeLeft = size;
        var iBlock = addrNext >>> this.nBlockShift;

        while (sizeLeft > 0 && iBlock < this.aMemBlocks.length) {

            var block = this.aMemBlocks[iBlock];
            var addrBlock = iBlock * this.nBlockSize;
            var sizeBlock = this.nBlockSize - (addrNext - addrBlock);
            if (sizeBlock > sizeLeft) sizeBlock = sizeLeft;

            if (block && block.size) {
                if (block.type == type && block.controller == controller) {
                    /*
                     * Where there is already a similar block with a non-zero size, we allow the allocation only if:
                     *
                     *   1) addrNext + sizeLeft <= block.addr (the request precedes the used portion of the current block), or
                     *   2) addrNext >= block.addr + block.used (the request follows the used portion of the current block)
                     */
                    if (addrNext + sizeLeft <= block.addr) {
                        block.used += (block.addr - addrNext);
                        block.addr = addrNext;
                        return true;
                    }
                    if (addrNext >= block.addr + block.used) {
                        var sizeAvail = block.size - (addrNext - addrBlock);
                        if (sizeAvail > sizeLeft) sizeAvail = sizeLeft;
                        block.used = addrNext - block.addr + sizeAvail;
                        addrNext = addrBlock + this.nBlockSize;
                        sizeLeft -= sizeAvail;
                        iBlock++;
                        continue;
                    }
                }
                return this.reportError(Bus.ERROR.ADD_MEM_INUSE, addrNext, sizeLeft);
            }

            var blockNew = new Memory(addrNext, sizeBlock, this.nBlockSize, type, controller);
            blockNew.copyBreakpoints(this.dbg, block);
            this.aMemBlocks[iBlock++] = blockNew;

            addrNext = addrBlock + this.nBlockSize;
            sizeLeft -= sizeBlock;
        }
        if (sizeLeft <= 0) {
            /*
             * If all addMemory() calls happened ONLY during device initialization, the following code would not
             * be necessary; unfortunately, the Video component can add and remove physical memory blocks during video
             * mode changes, so we have to kick out any PAGED blocks that could have references to those physical memory
             * blocks.  If paging isn't enabled (or supported by the current the CPU), this call has no effect.
             *
             * We could handle this case with a little more, um, precision, but Video mode changes aren't frequent enough
             * to warrant it.
             */
            this.cpu.flushPageBlocks();
            if (!this.cpu.isRunning()) {        // allocation messages at "run time" are bit too much
                var kb = (size / 1024)|0;
                var sb = kb? (kb + "Kb ") : (size + " bytes ");
                this.status(sb + Memory.TYPE.NAMES[type] + " at " + Str.toHex(addr));
            }
            return true;
        }
        return this.reportError(Bus.ERROR.ADD_MEM_BADRANGE, addr, size);
    }

    /**
     * cleanMemory(addr, size)
     *
     * @this {Bus}
     * @param {number} addr
     * @param {number} size
     * @return {boolean} true if all blocks were clean, false if dirty; all blocks are cleaned in the process
     */
    cleanMemory(addr, size)
    {
        var fClean = true;
        var iBlock = addr >>> this.nBlockShift;
        var sizeBlock = this.nBlockSize - (addr & this.nBlockLimit);
        while (size > 0 && iBlock < this.aMemBlocks.length) {
            if (this.aMemBlocks[iBlock].fDirty) {
                this.aMemBlocks[iBlock].fDirty = fClean = false;
                this.aMemBlocks[iBlock].fDirtyEver = true;
            }
            size -= sizeBlock;
            sizeBlock = this.nBlockSize;
            iBlock++;
        }
        return fClean;
    }

    /**
     * scanMemory(info, addr, size)
     *
     * Returns a BusInfo object for the specified address range.
     *
     * @this {Bus}
     * @param {Object} [info] previous BusInfo, if any
     * @param {number} [addr] starting address of range (0 if none provided)
     * @param {number} [size] size of range, in bytes (up to end of address space if none provided)
     * @return {Object} updated info (or new info if no previous info provided)
     */
    scanMemory(info, addr, size)
    {
        if (addr == null) addr = 0;
        if (size == null) size = (this.addrTotal - addr) | 0;
        if (info == null) info = {cbTotal: 0, cBlocks: 0, aBlocks: []};

        var iBlock = addr >>> this.nBlockShift;
        var iBlockMax = ((addr + size - 1) >>> this.nBlockShift);

        info.cbTotal = 0;
        info.cBlocks = 0;
        while (iBlock <= iBlockMax) {
            var block = this.aMemBlocks[iBlock];
            info.cbTotal += block.size;
            if (block.size) {
                var btmod = (BACKTRACK && block.modBackTrack(false)? 1 : 0);
                info.aBlocks.push(Usr.initBitFields(Bus.BlockInfo, iBlock, 0, btmod, block.type));
                info.cBlocks++
            }
            iBlock++;
        }
        return info;
    }

    /**
     * getA20()
     *
     * @this {Bus}
     * @return {boolean} true if enabled, false if disabled
     */
    getA20()
    {
        return !this.aBlocks2Mb && this.nBusLimit == this.nBusMask;
    }

    /**
     * setA20(fEnable)
     *
     * On 32-bit bus machines, I've adopted the approach that COMPAQ took with DeskPro 386 machines,
     * which is to map the 1st Mb to the 2nd Mb whenever A20 is disabled, rather than blindly masking
     * the A20 address bit from all addresses; in fact, this is what the DeskPro 386 ROM BIOS requires.
     *
     * For 24-bit bus machines, we take the same approach that most if not all 80286 systems took, which
     * is simply masking the A20 address bit.  A lot of 32-bit machines probably took the same approach.
     *
     * TODO: On machines with a 32-bit bus, look into whether we can eliminate address masking altogether,
     * which seems feasible, provided all incoming addresses are already pre-truncated to 32 bits.  Also,
     * confirm that DeskPro 386 machines mapped the ENTIRE 1st Mb to the 2nd, and not simply the first 64Kb,
     * which is technically all that 8086 address wrap-around compatibility would require.
     *
     * @this {Bus}
     * @param {boolean} fEnable is true to enable A20 (default), false to disable
     */
    setA20(fEnable)
    {
        if (this.nBusWidth == 32) {
            if (fEnable) {
                if (this.aBlocks2Mb) {
                    this.setMemoryBlocks(0x100000, 0x100000, this.aBlocks2Mb);
                    this.aBlocks2Mb = null;
                }
            } else {
                if (!this.aBlocks2Mb) {
                    this.aBlocks2Mb = this.getMemoryBlocks(0x100000, 0x100000);
                    this.setMemoryBlocks(0x100000, 0x100000, this.getMemoryBlocks(0x0, 0x100000));
                }
            }
        }
        else if (this.nBusWidth > 20) {
            var addrMask = (this.nBusMask & ~0x100000) | (fEnable? 0x100000 : 0);
            if (addrMask != this.nBusMask) {
                this.nBusMask = addrMask;
                if (this.cpu) this.cpu.setAddressMask(addrMask);
            }
        }
    }

    /**
     * getWidth()
     *
     * @this {Bus}
     * @return {number}
     */
    getWidth()
    {
        return this.nBusWidth;
    }

    /**
     * setMemoryAccess(addr, size, afn, fQuiet)
     *
     * Updates the access functions in every block of the specified address range.  Since the only components
     * that should be dynamically modifying the memory access functions are those that use addMemory() with a custom
     * memory controller, we require that the block(s) being updated do in fact have a controller.
     *
     * @this {Bus}
     * @param {number} addr
     * @param {number} size
     * @param {Array.<function()>} [afn]
     * @param {boolean} [fQuiet] (true if any error should be quietly logged)
     * @return {boolean} true if successful, false if not
     */
    setMemoryAccess(addr, size, afn, fQuiet)
    {
        if (!(addr & this.nBlockLimit) && size && !(size & this.nBlockLimit)) {
            var iBlock = addr >>> this.nBlockShift;
            while (size > 0) {
                var block = this.aMemBlocks[iBlock];
                if (!block.controller) {
                    return this.reportError(Bus.ERROR.SET_MEM_NOCTRL, addr, size, fQuiet);
                }
                block.setAccess(afn, true);
                size -= this.nBlockSize;
                iBlock++;
            }
            return true;
        }
        return this.reportError(Bus.ERROR.SET_MEM_BADRANGE, addr, size);
    }

    /**
     * removeMemory(addr, size)
     *
     * Replaces every block in the specified address range with empty Memory blocks that ignore all reads/writes.
     *
     * TODO: Update the removeMemory() interface to reflect the relaxed requirements of the addMemory() interface.
     *
     * @this {Bus}
     * @param {number} addr
     * @param {number} size
     * @return {boolean} true if successful, false if not
     */
    removeMemory(addr, size)
    {
        if (!(addr & this.nBlockLimit) && size && !(size & this.nBlockLimit)) {
            var iBlock = addr >>> this.nBlockShift;
            while (size > 0) {
                var blockOld = this.aMemBlocks[iBlock];
                var blockNew = new Memory(addr);
                blockNew.copyBreakpoints(this.dbg, blockOld);
                this.aMemBlocks[iBlock++] = blockNew;
                addr = iBlock * this.nBlockSize;
                size -= this.nBlockSize;
            }
            /*
             * If all removeMemory() calls happened ONLY during device initialization, the following code would not
             * be necessary; unfortunately, the Video component can add and remove physical memory blocks during video
             * mode changes, so we have to kick out any PAGED blocks that could have references to those physical memory
             * blocks.  If paging isn't enabled (or supported by the current the CPU), this call has no effect.
             *
             * We could handle this case with a little more, um, precision, but Video mode changes aren't frequent enough
             * to warrant it.
             */
            this.cpu.flushPageBlocks();
            return true;
        }
        return this.reportError(Bus.ERROR.REM_MEM_BADRANGE, addr, size);
    }

    /**
     * getMemoryBlocks(addr, size)
     *
     * @this {Bus}
     * @param {number} addr is the starting physical address
     * @param {number} size of the request, in bytes
     * @return {Array} of Memory blocks
     */
    getMemoryBlocks(addr, size)
    {
        var aBlocks = [];
        var iBlock = addr >>> this.nBlockShift;
        while (size > 0 && iBlock < this.aMemBlocks.length) {
            aBlocks.push(this.aMemBlocks[iBlock++]);
            size -= this.nBlockSize;
        }
        return aBlocks;
    }

    /**
     * setMemoryBlocks(addr, size, aBlocks, type)
     *
     * If no type is specified, then specified address range uses all the provided blocks as-is;
     * this form of setMemoryBlocks() is used for complete physical aliases.
     *
     * Otherwise, new blocks are allocated with the specified type; the underlying memory from the
     * provided blocks is still used, but the new blocks may have different access to that memory.
     *
     * @this {Bus}
     * @param {number} addr is the starting physical address
     * @param {number} size of the request, in bytes
     * @param {Array} aBlocks as returned by getMemoryBlocks()
     * @param {number} [type] is one of the Memory.TYPE constants
     */
    setMemoryBlocks(addr, size, aBlocks, type)
    {
        var i = 0;
        var iBlock = addr >>> this.nBlockShift;
        while (size > 0 && iBlock < this.aMemBlocks.length) {
            var block = aBlocks[i++];
            this.assert(block);
            if (!block) break;
            if (type !== undefined) {
                var blockNew = new Memory(addr);
                blockNew.clone(block, type, this.dbg);
                block = blockNew;
            }
            this.aMemBlocks[iBlock++] = block;
            size -= this.nBlockSize;
        }
    }

    /**
     * getByte(addr)
     *
     * For physical addresses only; for linear addresses, use cpu.getByte().
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @return {number} byte (8-bit) value at that address
     */
    getByte(addr)
    {
        return this.aMemBlocks[(addr & this.nBusMask) >>> this.nBlockShift].readByte(addr & this.nBlockLimit, addr);
    }

    /**
     * getByteDirect(addr)
     *
     * This is useful for the Debugger and other components that want to bypass getByte() breakpoint detection.
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @return {number} byte (8-bit) value at that address
     */
    getByteDirect(addr)
    {
        return this.aMemBlocks[(addr & this.nBusMask) >>> this.nBlockShift].readByteDirect(addr & this.nBlockLimit, addr);
    }

    /**
     * getShort(addr)
     *
     * For physical addresses only; for linear addresses, use cpu.getShort().
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @return {number} word (16-bit) value at that address
     */
    getShort(addr)
    {
        var off = addr & this.nBlockLimit;
        var iBlock = (addr & this.nBusMask) >>> this.nBlockShift;
        if (off != this.nBlockLimit) {
            return this.aMemBlocks[iBlock].readShort(off, addr);
        }
        return this.aMemBlocks[iBlock++].readByte(off, addr) | (this.aMemBlocks[iBlock & this.nBlockMask].readByte(0, addr + 1) << 8);
    }

    /**
     * getShortDirect(addr)
     *
     * This is useful for the Debugger and other components that want to bypass getShort() breakpoint detection.
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @return {number} word (16-bit) value at that address
     */
    getShortDirect(addr)
    {
        var off = addr & this.nBlockLimit;
        var iBlock = (addr & this.nBusMask) >>> this.nBlockShift;
        if (off != this.nBlockLimit) {
            return this.aMemBlocks[iBlock].readShortDirect(off, addr);
        }
        return this.aMemBlocks[iBlock++].readByteDirect(off, addr) | (this.aMemBlocks[iBlock & this.nBlockMask].readByteDirect(0, addr + 1) << 8);
    }

    /**
     * getLong(addr)
     *
     * For physical addresses only; for linear addresses, use cpu.getLong().
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @return {number} long (32-bit) value at that address
     */
    getLong(addr)
    {
        var off = addr & this.nBlockLimit;
        var iBlock = (addr & this.nBusMask) >>> this.nBlockShift;
        if (off < this.nBlockLimit - 2) {
            return this.aMemBlocks[iBlock].readLong(off, addr);
        }
        /*
         * I think the previous version of this function tried to be too clever (ie, reading the last
         * long in the current block and the first long in the next block and masking/combining the results),
         * which may have also created some undesirable side-effects for custom memory controllers.
         * This simpler (and probably more reliable) approach is to simply read the long as individual bytes.
         */
        var l = 0;
        var cb = 4, nShift = 0;
        var cbBlock = 4 - (off & 0x3);    // (off & 0x3) will be 1, 2 or 3, so cbBlock will be 3, 2, or 1
        while (cb--) {
            l |= (this.aMemBlocks[iBlock].readByte(off++, addr++) << nShift);
            if (!--cbBlock) {
                iBlock = (iBlock + 1) & this.nBlockMask;
                off = 0;
            }
            nShift += 8;
        }
        return l;
    }

    /**
     * setByte(addr, b)
     *
     * For physical addresses only; for linear addresses, use cpu.setByte().
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @param {number} b is the byte (8-bit) value to write (we truncate it to 8 bits to be safe)
     */
    setByte(addr, b)
    {
        this.aMemBlocks[(addr & this.nBusMask) >>> this.nBlockShift].writeByte(addr & this.nBlockLimit, b & 0xff, addr);
    }

    /**
     * setByteDirect(addr, b)
     *
     * This is useful for the Debugger and other components that want to bypass breakpoint detection AND read-only
     * memory protection (for example, this is an interface the ROM component could use to initialize ROM contents).
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @param {number} b is the byte (8-bit) value to write (we truncate it to 8 bits to be safe)
     */
    setByteDirect(addr, b)
    {
        this.aMemBlocks[(addr & this.nBusMask) >>> this.nBlockShift].writeByteDirect(addr & this.nBlockLimit, b & 0xff, addr);
    }

    /**
     * setShort(addr, w)
     *
     * For physical addresses only; for linear addresses, use cpu.setShort().
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @param {number} w is the word (16-bit) value to write (we truncate it to 16 bits to be safe)
     */
    setShort(addr, w)
    {
        var off = addr & this.nBlockLimit;
        var iBlock = (addr & this.nBusMask) >>> this.nBlockShift;
        if (off != this.nBlockLimit) {
            this.aMemBlocks[iBlock].writeShort(off, w & 0xffff, addr);
            return;
        }
        this.aMemBlocks[iBlock++].writeByte(off, w & 0xff, addr);
        this.aMemBlocks[iBlock & this.nBlockMask].writeByte(0, (w >> 8) & 0xff, addr + 1);
    }

    /**
     * setShortDirect(addr, w)
     *
     * This is useful for the Debugger and other components that want to bypass breakpoint detection AND read-only
     * memory protection (for example, this is an interface the ROM component could use to initialize ROM contents).
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @param {number} w is the word (16-bit) value to write (we truncate it to 16 bits to be safe)
     */
    setShortDirect(addr, w)
    {
        var off = addr & this.nBlockLimit;
        var iBlock = (addr & this.nBusMask) >>> this.nBlockShift;
        if (off != this.nBlockLimit) {
            this.aMemBlocks[iBlock].writeShortDirect(off, w & 0xffff, addr);
            return;
        }
        this.aMemBlocks[iBlock++].writeByteDirect(off, w & 0xff, addr);
        this.aMemBlocks[iBlock & this.nBlockMask].writeByteDirect(0, (w >> 8) & 0xff, addr + 1);
    }

    /**
     * setLong(addr, l)
     *
     * For physical addresses only; for linear addresses, use cpu.setLong().
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @param {number} l is the long (32-bit) value to write
     */
    setLong(addr, l)
    {
        var off = addr & this.nBlockLimit;
        var iBlock = (addr & this.nBusMask) >>> this.nBlockShift;
        if (off < this.nBlockLimit - 2) {
            this.aMemBlocks[iBlock].writeLong(off, l);
            return;
        }
        /*
         * I think the previous version of this function tried to be too clever (ie, reading and rewriting
         * the last long in the current block, and then reading and rewriting the first long in the next
         * block), which may have also created some undesirable side-effects for custom memory controllers.
         * This simpler (and probably more reliable) approach is to simply write the long as individual bytes.
         */
        var cb = 4;
        var cbBlock = 4 - (off & 0x3);    // (off & 0x3) will be 1, 2 or 3, so cbBlock will be 3, 2, or 1
        while (cb--) {
            this.aMemBlocks[iBlock].writeByte(off++, l & 0xff, addr++);
            if (!--cbBlock) {
                iBlock = (iBlock + 1) & this.nBlockMask;
                off = 0;
            }
            l >>>= 8;
        }
    }

    /**
     * addBackTrackObject(obj, bto, off)
     *
     * If bto is null, then we create bto (ie, an object that wraps obj and records off).
     *
     * If bto is NOT null, then we verify that off is within the given bto's range; if not,
     * then we must create a new bto and return that instead.
     *
     * @this {Bus}
     * @param {Object} obj
     * @param {BackTrack|null} bto
     * @param {number} off (the offset within obj that this wrapper object is relative to)
     * @return {BackTrack|null}
     */
    addBackTrackObject(obj, bto, off)
    {
        if (BACKTRACK && obj) {
            var cbtObjects = this.abtObjects.length;
            if (!bto) {
                /*
                 * Try the most recently created bto, on the off-chance it's what the caller needs
                 */
                if (this.ibtLastAlloc >= 0) bto = this.abtObjects[this.ibtLastAlloc];
            }
            if (!bto || bto.obj != obj || off < bto.off || off >= bto.off + Bus.BTINFO.OFF_MAX) {

                bto = {obj: obj, off: off, slot: 0, refs: 0};

                var slot;
                if (!this.cbtDeletions) {
                    slot = cbtObjects;
                } else {
                    for (slot = this.ibtLastDelete; slot < cbtObjects; slot++) {
                        var btoTest = this.abtObjects[slot];
                        if (!btoTest || !btoTest.refs && !this.isBackTrackWeak(slot << Bus.BTINFO.SLOT_SHIFT)) {
                            this.ibtLastDelete = slot + 1;
                            this.cbtDeletions--;
                            break;
                        }
                    }
                    /*
                     * There's no longer any guarantee that simply because cbtDeletions was non-zero that there WILL
                     * be an available (existing) slot, because cbtDeletions also counts weak references that may still
                     * be weak.
                     *
                     *      this.assert(slot < cbtObjects);
                     */
                }
                /*
                 *  I hit the following error after running in a machine with lots of disk activity:
                 *
                 *      Error: assertion failure in deskpro386.bus
                 *      at Bus.Component.assert (http://pcjs:8088/modules/shared/lib/component.js:732:31)
                 *      at Bus.addBackTrackObject (http://pcjs:8088/modules/pcx86/lib/bus.js:980:18)
                 *      at onATCReadData (http://pcjs:8088/modules/pcx86/lib/hdc.js:1410:35)
                 *      at HDC.readData (http://pcjs:8088/modules/pcx86/lib/hdc.js:2573:23)
                 *      at HDC.inATCByte (http://pcjs:8088/modules/pcx86/lib/hdc.js:1398:20)
                 *      at HDC.inATCData (http://pcjs:8088/modules/pcx86/lib/hdc.js:1487:17)
                 *      at Bus.checkPortInputNotify (http://pcjs:8088/modules/pcx86/lib/bus.js:1457:38)
                 *      at X86CPU.INSw (http://pcjs:8088/modules/pcx86/lib/x86ops.js:1640:26)
                 *      at X86CPU.stepCPU (http://pcjs:8088/modules/pcx86/lib/x86cpu.js:4637:37)
                 *      at X86CPU.CPU.runCPU (http://pcjs:8088/modules/pcx86/lib/cpu.js:1014:22)
                 *
                 * TODO: Investigate.  For now, BACKTRACK is completely disabled (in part because it also needs
                 * to be revamped for machines with paging enabled).
                 */
                this.assert(slot < Bus.BTINFO.SLOT_MAX);
                this.ibtLastAlloc = slot;
                bto.slot = slot + 1;
                if (slot == cbtObjects) {
                    this.abtObjects.push(bto);
                } else {
                    this.abtObjects[slot] = bto;
                }
            }
            return bto;
        }
        return null;
    }

    /**
     * getBackTrackIndex(bto, off)
     *
     * @this {Bus}
     * @param {BackTrack|null} bto
     * @param {number} off
     * @return {number}
     */
    getBackTrackIndex(bto, off)
    {
        var bti = 0;
        if (BACKTRACK && bto) {
            bti = (bto.slot << Bus.BTINFO.SLOT_SHIFT) | Bus.BTINFO.TYPE_DATA | (off - bto.off);
        }
        return bti;
    }

    /**
     * writeBackTrackObject(addr, bto, off)
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @param {BackTrack|null} bto
     * @param {number} off
     */
    writeBackTrackObject(addr, bto, off)
    {
        if (BACKTRACK && bto) {
            this.assert(off - bto.off >= 0 && off - bto.off < Bus.BTINFO.OFF_MAX);
            var bti = (bto.slot << Bus.BTINFO.SLOT_SHIFT) | Bus.BTINFO.TYPE_DATA | (off - bto.off);
            this.writeBackTrack(addr, bti);
        }
    }

    /**
     * readBackTrack(addr)
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @return {number}
     */
    readBackTrack(addr)
    {
        if (BACKTRACK) {
            return this.aMemBlocks[(addr & this.nBusMask) >>> this.nBlockShift].readBackTrack(addr & this.nBlockLimit);
        }
        return 0;
    }

    /**
     * writeBackTrack(addr, bti)
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @param {number} bti
     */
    writeBackTrack(addr, bti)
    {
        if (BACKTRACK) {
            var slot = bti >>> Bus.BTINFO.SLOT_SHIFT;
            var iBlock = (addr & this.nBusMask) >>> this.nBlockShift;
            var btiPrev = this.aMemBlocks[iBlock].writeBackTrack(addr & this.nBlockLimit, bti);
            var slotPrev = btiPrev >>> Bus.BTINFO.SLOT_SHIFT;
            if (slot != slotPrev) {
                this.aMemBlocks[iBlock].modBackTrack(true);
                if (btiPrev && slotPrev) {
                    var btoPrev = this.abtObjects[slotPrev-1];
                    if (!btoPrev) {
                        if (DEBUGGER && this.dbg && this.dbg.messageEnabled(Messages.WARN)) {
                            this.dbg.message("writeBackTrack(%" + Str.toHex(addr) + ',' + Str.toHex(bti) + "): previous index (" + Str.toHex(btiPrev) + ") refers to empty slot (" + slotPrev + ")");
                        }
                    }
                    else if (btoPrev.refs <= 0) {
                        if (DEBUGGER && this.dbg && this.dbg.messageEnabled(Messages.WARN)) {
                            this.dbg.message("writeBackTrack(%" + Str.toHex(addr) + ',' + Str.toHex(bti) + "): previous index (" + Str.toHex(btiPrev) + ") refers to object with bad ref count (" + btoPrev.refs + ")");
                        }
                    } else if (!--btoPrev.refs) {
                        /*
                         * We used to just slam a null into the previous slot and consider it gone, but there may still
                         * be "weak references" to that slot (ie, it may still be associated with a register bti).
                         *
                         * The easiest way to handle weak references is to leave the slot allocated, with the object's ref
                         * count sitting at zero, and change addBackTrackObject() to look for both empty slots AND non-empty
                         * slots with a ref count of zero; in the latter case, it should again check for weak references,
                         * after which we can re-use the slot if all its weak references are now gone.
                         */
                        if (!this.isBackTrackWeak(btiPrev)) this.abtObjects[slotPrev-1] = null;
                        /*
                         * TODO: Consider what the appropriate trigger should be for resetting ibtLastDelete to zero;
                         * if we don't OCCASIONALLY set it to zero, we may never clear out obsolete weak references,
                         * whereas if we ALWAYS set it to zero, we may be forcing addBackTrackObject() to scan the entire
                         * table too often.
                         *
                         * I'd prefer to do something like this:
                         *
                         *      if (this.ibtLastDelete > slotPrev-1) this.ibtLastDelete = slotPrev-1;
                         *
                         * or even this:
                         *
                         *      if (this.ibtLastDelete > slotPrev-1) this.ibtLastDelete = 0;
                         *
                         * But neither one of those guarantees that we will at least occasionally scan the entire table.
                         */
                        this.ibtLastDelete = 0;
                        this.cbtDeletions++;
                    }
                }
                if (bti && slot) {
                    var bto = this.abtObjects[slot-1];
                    if (bto) {
                        this.assert(slot == bto.slot);
                        bto.refs++;
                    }
                }
            }
        }
    }

    /**
     * isBackTrackWeak(bti)
     *
     * @param {number} bti
     * @returns {boolean} true if the given bti is still referenced by a register, false if not
     */
    isBackTrackWeak(bti)
    {
        var bt = this.cpu.backTrack;
        var slot = bti >> Bus.BTINFO.SLOT_SHIFT;
        return (bt.btiAL   >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiAH   >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiBL   >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiBH   >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiCL   >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiCH   >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiDL   >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiDH   >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiBPLo >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiBPHi >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiSILo >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiSIHi >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiDILo >> Bus.BTINFO.SLOT_SHIFT == slot ||
                bt.btiDIHi >> Bus.BTINFO.SLOT_SHIFT == slot
        );
    }

    /**
     * updateBackTrackCode(addr, bti)
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @param {number} bti
     */
    updateBackTrackCode(addr, bti)
    {
        if (BACKTRACK) {
            if (bti & Bus.BTINFO.TYPE_DATA) {
                bti = (bti & ~Bus.BTINFO.TYPE_MASK) | Bus.BTINFO.TYPE_COUNT_INC;
            } else if ((bti & Bus.BTINFO.TYPE_MASK) < Bus.BTINFO.TYPE_COUNT_MAX) {
                bti += Bus.BTINFO.TYPE_COUNT_INC;
            } else {
                return;
            }
            this.aMemBlocks[(addr & this.nBusMask) >>> this.nBlockShift].writeBackTrack(addr & this.nBlockLimit, bti);
        }
    }

    /**
     * getBackTrackObject(bti)
     *
     * @this {Bus}
     * @param {number} bti
     * @return {Object|null}
     */
    getBackTrackObject(bti)
    {
        if (BACKTRACK) {
            var slot = bti >>> Bus.BTINFO.SLOT_SHIFT;
            if (slot) return this.abtObjects[slot-1];
        }
        return null;
    }

    /**
     * getBackTrackInfo(bti, fSymbol, fNearest)
     *
     * @this {Bus}
     * @param {number} bti
     * @param {boolean} [fSymbol] (true to return only symbol)
     * @param {boolean} [fNearest] (true to return nearest symbol)
     * @return {string|null}
     */
    getBackTrackInfo(bti, fSymbol, fNearest)
    {
        if (BACKTRACK) {
            var bto = this.getBackTrackObject(bti);
            if (bto) {
                var off = bti & Bus.BTINFO.OFF_MASK;
                var file = bto.obj.file;
                if (file) {
                    this.assert(!bto.off);
                    return file.getSymbol(bto.obj.offFile + off, fNearest);
                }
                if (!fSymbol || fNearest) {
                    if (bto.obj.idComponent) {
                        return bto.obj.idComponent + '+' + Str.toHex(bto.off + off, 0, true);
                    }
                }
            }
        }
        return null;
    }

    /**
     * getSymbol(addr, fNearest)
     *
     * @this {Bus}
     * @param {number} addr
     * @param {boolean} [fNearest] (true to return nearest symbol)
     * @return {string|null}
     */
    getSymbol(addr, fNearest)
    {
        return BACKTRACK? this.getBackTrackInfo(this.readBackTrack(addr), true, fNearest) : null;
    }

    /**
     * saveMemory(fAll)
     *
     * The only memory blocks we save are those marked as dirty, but most likely all of RAM will have been marked dirty,
     * and even if our dirty-memory flags were as smart as our dirty-sector flags (ie, were set only when a write changed
     * what was already there), it's unlikely that would reduce the number of RAM blocks we must save/restore.  At least
     * all the ROM blocks should be clean (except in the unlikely event that the Debugger was used to modify them).
     *
     * All dirty blocks will be stored in a single array, as pairs of block numbers and data arrays, like so:
     *
     *      [iBlock0, [dw0, dw1, ...], iBlock1, [dw0, dw1, ...], ...]
     *
     * In a normal 4Kb block, there will be 1K DWORD values in the data array.  Remember that each DWORD is a signed 32-bit
     * integer (because they are formed using bitwise operator rather than floating-point math operators), so don't be
     * surprised to see negative numbers in the data.
     *
     * The above example assumes "uncompressed" data arrays.  If we choose to use "compressed" data arrays, the data arrays
     * will look like:
     *
     *      [count0, dw0, count1, dw1, ...]
     *
     * where each count indicates how many times the following DWORD value occurs.  A data array length less than 1K indicates
     * that it's compressed, since we'll only store them in compressed form if they actually shrank, and we'll use State
     * helper methods compress() and decompress() to create and expand the compressed data arrays.
     *
     * @this {Bus}
     * @param {boolean} [fAll] (true to save all non-ROM memory blocks, regardless of their dirty flags)
     * @return {Array} a
     */
    saveMemory(fAll)
    {
        var i = 0;
        var a = [];

        /*
         * A quick-and-dirty work-around for 32-bit bus machines, to ensure that all blocks in the 2nd Mb are
         * mapped in before we save.  We do this by forcing A20 on, and then turning it off again before we leave.
         */
        var fA20 = this.getA20();
        if (!fA20) this.setA20(true);

        for (var iBlock = 0; iBlock < this.nBlockTotal; iBlock++) {
            var block = this.aMemBlocks[iBlock];
            /*
             * We have to check both fDirty and fDirtyEver, because we may have called cleanMemory() on some of
             * the memory blocks (eg, video memory), and while cleanMemory() will clear a dirty block's fDirty flag,
             * it also sets the dirty block's fDirtyEver flag, which is left set for the lifetime of the machine.
             */
            if (fAll && block.type != Memory.TYPE.ROM || block.fDirty || block.fDirtyEver) {
                a[i++] = iBlock;
                a[i++] = State.compress(block.save());
            }
        }

        if (!fA20) this.setA20(false);
        a[i] = fA20;

        return a;
    }

    /**
     * restoreMemory(a)
     *
     * This restores the contents of all Memory blocks; called by X86CPU.restore().
     *
     * In theory, we ONLY have to save/restore block contents.  Other block attributes,
     * like the type, the memory controller (if any), and the active memory access functions,
     * should already be restored, since every component (re)allocates all the memory blocks
     * it was using when it's restored.  And since the CPU is guaranteed to be the last
     * component to be restored, all those blocks (and their attributes) should be in place now.
     *
     * See saveMemory() for more information on how the memory block contents are saved.
     *
     * @this {Bus}
     * @param {Array} a
     * @return {boolean} true if successful, false if not
     */
    restoreMemory(a)
    {
        var i;
        for (i = 0; i < a.length - 1; i += 2) {
            var iBlock = a[i];
            var adw = a[i+1];
            if (adw && adw.length < this.nBlockLen) {
                adw = State.decompress(adw, this.nBlockLen);
            }
            var block = this.aMemBlocks[iBlock];
            if (!block || !block.restore(adw)) {
                /*
                 * Either the block to restore hasn't been allocated, indicating a change in the machine
                 * configuration since it was last saved (the most likely explanation) or there's some internal
                 * inconsistency (eg, the block size is wrong).
                 */
                Component.error("Unable to restore memory block " + iBlock);
                return false;
            }
        }
        if (a[i] !== undefined) this.setA20(a[i]);
        return true;
    }

    /**
     * addPortInputBreak(port)
     *
     * @this {Bus}
     * @param {number|null} [port]
     * @return {boolean} true if break on port input enabled, false if disabled
     */
    addPortInputBreak(port)
    {
        if (port == null) {
            this.fPortInputBreakAll = !this.fPortInputBreakAll;
            return this.fPortInputBreakAll;
        }
        if (this.aPortInputNotify[port] === undefined) {
            this.aPortInputNotify[port] = [null, false];
        }
        this.aPortInputNotify[port][1] = !this.aPortInputNotify[port][1];
        return this.aPortInputNotify[port][1];
    }

    /**
     * addPortInputNotify(start, end, fn)
     *
     * Add a port input-notification handler to the list of such handlers.
     *
     * @this {Bus}
     * @param {number} start port address
     * @param {number} end port address
     * @param {function(number,number)} fn is called with the port and LIP values at the time of the input
     */
    addPortInputNotify(start, end, fn)
    {
        if (fn !== undefined) {
            for (var port = start; port <= end; port++) {
                if (this.aPortInputNotify[port] !== undefined) {
                    Component.warning("Input port " + Str.toHexWord(port) + " already registered");
                    continue;
                }
                this.aPortInputNotify[port] = [fn, false];
                if (MAXDEBUG) this.log("addPortInputNotify(" + Str.toHexWord(port) + ")");
            }
        }
    }

    /**
     * addPortInputTable(component, table, offset)
     *
     * Add port input-notification handlers from the specified table (a batch version of addPortInputNotify)
     *
     * @this {Bus}
     * @param {Component} component
     * @param {Object} table
     * @param {number} [offset] is an optional port offset
     */
    addPortInputTable(component, table, offset)
    {
        if (offset === undefined) offset = 0;
        for (var port in table) {
            this.addPortInputNotify(+port + offset, +port + offset, table[port].bind(component));
        }
    }

    /**
     * addPortInputWidth(port, size)
     *
     * By default, all input ports are 1 byte wide; ports that are wider must call this function.
     *
     * @this {Bus}
     * @param {number} port
     * @param {number} size (1, 2 or 4)
     */
    addPortInputWidth(port, size)
    {
        this.aPortInputWidth[port] = size;
    }

    /**
     * checkPortInputNotify(port, size, addrLIP)
     *
     * @this {Bus}
     * @param {number} port
     * @param {number} size (1, 2 or 4)
     * @param {number} [addrLIP] is the LIP value at the time of the input
     * @return {number} simulated port data
     *
     * NOTE: It seems that parts of the ROM BIOS (like the RS-232 probes around F000:E5D7 in the 5150 BIOS)
     * assume that ports for non-existent hardware return 0xff rather than 0x00, hence my new default (0xff) below.
     */
    checkPortInputNotify(port, size, addrLIP)
    {
        var data = 0, shift = 0;

        while (size > 0) {

            var aNotify = this.aPortInputNotify[port];
            var sizePort = this.aPortInputWidth[port] || 1;
            var maskPort = (sizePort == 1? 0xff : (sizePort == 2? 0xffff : -1));
            var dataPort = maskPort;

            /*
             * TODO: We need to decide what to do about 8-bit I/O to a 16-bit port (ditto for 16-bit I/O
             * to a 32-bit port).  We probably should pass the size through to the aNotify[0] handler,
             * and let it decide what to do, but I don't feel like changing all the I/O handlers right now.
             * The good news, at least, is that the 8-bit handlers would not have to do anything special.
             * This assert will warn us if this is a pressing need.
             */
            this.assert(size >= sizePort);

            if (BACKTRACK) {
                this.cpu.backTrack.btiIO = 0;
            }

            if (aNotify !== undefined) {
                if (aNotify[0]) {
                    dataPort = aNotify[0](port, addrLIP);
                    if (dataPort == null) {
                        dataPort = maskPort;
                    } else {
                        dataPort &= maskPort;
                    }
                }
                if (DEBUGGER && this.dbg && this.fPortInputBreakAll != aNotify[1]) {
                    this.dbg.checkPortInput(port, size, dataPort);
                }
            }
            else {
                if (DEBUGGER && this.dbg) {
                    this.dbg.messageIO(this, port, null, addrLIP);
                    if (this.fPortInputBreakAll) this.dbg.checkPortInput(port, size, dataPort);
                }
            }

            data |= dataPort << shift;
            shift += (sizePort << 3);
            port += sizePort;
            size -= sizePort;
        }

        this.assert(!size);
        return data;
    }

    /**
     * addPortOutputBreak(port)
     *
     * @this {Bus}
     * @param {number|null} [port]
     * @return {boolean} true if break on port output enabled, false if disabled
     */
    addPortOutputBreak(port)
    {
        if (port == null) {
            this.fPortOutputBreakAll = !this.fPortOutputBreakAll;
            return this.fPortOutputBreakAll;
        }
        if (this.aPortOutputNotify[port] === undefined) {
            this.aPortOutputNotify[port] = [null, false];
        }
        this.aPortOutputNotify[port][1] = !this.aPortOutputNotify[port][1];
        return this.aPortOutputNotify[port][1];
    }

    /**
     * addPortOutputNotify(start, end, fn)
     *
     * Add a port output-notification handler to the list of such handlers.
     *
     * @this {Bus}
     * @param {number} start port address
     * @param {number} end port address
     * @param {function(number,number)} fn is called with the port and LIP values at the time of the output
     */
    addPortOutputNotify(start, end, fn)
    {
        if (fn !== undefined) {
            for (var port = start; port <= end; port++) {
                if (this.aPortOutputNotify[port] !== undefined) {
                    Component.warning("Output port " + Str.toHexWord(port) + " already registered");
                    continue;
                }
                this.aPortOutputNotify[port] = [fn, false];
                if (MAXDEBUG) this.log("addPortOutputNotify(" + Str.toHexWord(port) + ")");
            }
        }
    }

    /**
     * addPortOutputTable(component, table, offset)
     *
     * Add port output-notification handlers from the specified table (a batch version of addPortOutputNotify)
     *
     * @this {Bus}
     * @param {Component} component
     * @param {Object} table
     * @param {number} [offset] is an optional port offset
     */
    addPortOutputTable(component, table, offset)
    {
        if (offset === undefined) offset = 0;
        for (var port in table) {
            this.addPortOutputNotify(+port + offset, +port + offset, table[port].bind(component));
        }
    }

    /**
     * addPortOutputWidth(port, size)
     *
     * By default, all output ports are 1 byte wide; ports that are wider must call this function.
     *
     * @this {Bus}
     * @param {number} port
     * @param {number} size (1, 2 or 4)
     */
    addPortOutputWidth(port, size)
    {
        this.aPortOutputWidth[port] = size;
    }

    /**
     * checkPortOutputNotify(port, size, data, addrLIP)
     *
     * @this {Bus}
     * @param {number} port
     * @param {number} size
     * @param {number} data
     * @param {number} [addrLIP] is the LIP value at the time of the output
     */
    checkPortOutputNotify(port, size, data, addrLIP)
    {
        var shift = 0;

        while (size > 0) {

            var aNotify = this.aPortOutputNotify[port];
            var sizePort = this.aPortOutputWidth[port] || 1;
            var maskPort = (sizePort == 1? 0xff : (sizePort == 2? 0xffff : -1));
            var dataPort = (data >>>= shift) & maskPort;

            /*
             * TODO: We need to decide what to do about 8-bit I/O to a 16-bit port (ditto for 16-bit I/O
             * to a 32-bit port).  We probably should pass the size through to the aNotify[0] handler,
             * and let it decide what to do, but I don't feel like changing all the I/O handlers right now.
             * The good news, at least, is that the 8-bit handlers would not have to do anything special.
             * This assert will warn us if this is a pressing need.
             */
            this.assert(size >= sizePort);

            if (aNotify !== undefined) {
                if (aNotify[0]) {
                    aNotify[0](port, dataPort, addrLIP);
                }
                if (DEBUGGER && this.dbg && this.fPortOutputBreakAll != aNotify[1]) {
                    this.dbg.checkPortOutput(port, size, dataPort);
                }
            }
            else {
                if (DEBUGGER && this.dbg) {
                    this.dbg.messageIO(this, port, dataPort, addrLIP);
                    if (this.fPortOutputBreakAll) this.dbg.checkPortOutput(port, size, dataPort);
                }
            }

            shift += (sizePort << 3);
            port += sizePort;
            size -= sizePort;
        }
        this.assert(!size);
    }

    /**
     * reportError(op, addr, size, fQuiet)
     *
     * @this {Bus}
     * @param {number} op
     * @param {number} addr
     * @param {number} size
     * @param {boolean} [fQuiet] (true if any error should be quietly logged)
     * @return {boolean} false
     */
    reportError(op, addr, size, fQuiet)
    {
        var sError = "Memory block error (" + op + ": " + Str.toHex(addr) + "," + Str.toHex(size) + ")";
        if (fQuiet) {
            if (this.dbg) {
                this.dbg.message(sError);
            } else {
                this.log(sError);
            }
        } else {
            Component.error(sError);
        }
        return false;
    }

    /**
     * getLongDirect(addr)
     *
     * This is useful for the Debugger and other components that want to bypass getLong() breakpoint detection.
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @return {number} long (32-bit) value at that address
     *
     getLongDirect(addr)
     {
         var off = addr & this.nBlockLimit;
         var iBlock = (addr & this.nBusMask) >>> this.nBlockShift;
         if (off < this.nBlockLimit - 2) {
             return this.aMemBlocks[iBlock].readLongDirect(off, addr);
         }
         //
         // I think the previous version of this function tried to be too clever (ie, reading the last
         // long in the current block and the first long in the next block and masking/combining the results),
         // which may have also created some undesirable side-effects for custom memory controllers.
         // This simpler (and probably more reliable) approach is to simply read the long as individual bytes.
         //
         var l = 0;
         var cb = 4, nShift = 0;
         var cbBlock = 4 - (off & 0x3);    // (off & 0x3) will be 1, 2 or 3, so cbBlock will be 3, 2, or 1
         while (cb--) {
             l |= (this.aMemBlocks[iBlock].readByteDirect(off++, addr++) << nShift);
             if (!--cbBlock) {
                 iBlock = (iBlock + 1) & this.nBlockMask;
                 off = 0;
             }
             nShift += 8;
         }
         return l;
     }
     */

    /**
     * setLongDirect(addr, l)
     *
     * This is useful for the Debugger and other components that want to bypass breakpoint detection AND read-only
     * memory protection (for example, this is an interface the ROM component could use to initialize ROM contents).
     *
     * @this {Bus}
     * @param {number} addr is a physical address
     * @param {number} l is the long (32-bit) value to write
     *
     setLongDirect(addr, l)
     {
         var off = addr & this.nBlockLimit;
         var iBlock = (addr & this.nBusMask) >>> this.nBlockShift;
         if (off < this.nBlockLimit - 2) {
             this.aMemBlocks[iBlock].writeLongDirect(off, l, addr);
             return;
         }
         //
         // I think the previous version of this function tried to be too clever (ie, reading and rewriting
         // the last long in the current block, and then reading and rewriting the first long in the next
         // block), which may have also created some undesirable side-effects for custom memory controllers.
         // This simpler (and probably more reliable) approach is to simply write the long as individual bytes.
         //
         var cb = 4;
         var cbBlock = 4 - (off & 0x3);    // (off & 0x3) will be 1, 2 or 3, so cbBlock will be 3, 2, or 1
         while (cb--) {
             this.aMemBlocks[iBlock].writeByteDirect(off++, l & 0xff, addr++);
             if (!--cbBlock) {
                 iBlock = (iBlock + 1) & this.nBlockMask;
                 off = 0;
             }
             l >>>= 8;
         }
     }
     */

    /**
     * getBackTrackObjectFromAddr(addr)
     *
     * @this {Bus}
     * @param {number} addr
     * @return {Object|null}
     *
     getBackTrackObjectFromAddr(addr)
     {
         return BACKTRACK? this.getBackTrackObject(this.readBackTrack(addr)) : null;
     }
     */

    /**
     * getBackTrackInfoFromAddr(addr)
     *
     * @this {Bus}
     * @param {number} addr
     * @return {string|null}
     *
     getBackTrackInfoFromAddr(addr)
     {
         return BACKTRACK? this.getBackTrackInfo(this.readBackTrack(addr)) : null;
     }
     */

    /**
     * removePortInputNotify(start, end)
     *
     * Remove port input-notification handler(s) (to be ENABLED later if needed)
     *
     * @this {Bus}
     * @param {number} start address
     * @param {number} end address
     *
     removePortInputNotify(start, end)
     {
         for (var port = start; port < end; port++) {
             if (this.aPortInputNotify[port]) {
                 delete this.aPortInputNotify[port];
             }
         }
     }
     */

    /**
     * removePortOutputNotify(start, end)
     *
     * Remove port output-notification handler(s) (to be ENABLED later if needed)
     *
     * @this {Bus}
     * @param {number} start address
     * @param {number} end address
     *
     removePortOutputNotify(start, end)
     {
         for (var port = start; port < end; port++) {
             if (this.aPortOutputNotify[port]) {
                 delete this.aPortOutputNotify[port];
             }
         }
     }
     */
}

/*
 * Data types used by scanMemory()
 */

/**
 * @typedef {number}
 */
var BlockInfo;

/**
 * This defines the BlockInfo bit fields used by scanMemory() when it creates the aBlocks array.
 *
 * @typedef {{
 *  num:    BitField,
 *  count:  BitField,
 *  btmod:  BitField,
 *  type:   BitField
 * }}
 */
Bus.BlockInfo = Usr.defineBitFields({num:20, count:8, btmod:1, type:3});

/**
 * BusInfo object definition (returned by scanMemory())
 *
 *  cbTotal:    total bytes allocated
 *  cBlocks:    total Memory blocks allocated
 *  aBlocks:    array of allocated Memory block numbers
 *
 * @typedef {{
 *  cbTotal:    number,
 *  cBlocks:    number,
 *  aBlocks:    Array.<BlockInfo>
 * }}
 */
var BusInfo;

if (BACKTRACK) {
    /**
     * BackTrack object definition
     *
     *  obj:        reference to the source object (eg, ROM object, Sector object)
     *  off:        the offset within the source object that this object refers to
     *  slot:       the slot (+1) in abtObjects which this object currently occupies
     *  refs:       the number of memory references, as recorded by writeBackTrack()
     *
     * @typedef {{
     *  obj:        Object,
     *  off:        number,
     *  slot:       number,
     *  refs:       number
     * }}
     */
    var BackTrack;

    /*
     * BackTrack indexes are 31-bit values, where bits 0-8 store an object offset (0-511) and bits 16-30 store
     * an object number (1-32767).  Object number 0 is reserved for dynamic data (ie, data created independent
     * of any source); examples include zero values produced by instructions such as "SUB AX,AX" or "XOR AX,AX".
     * We must special-case instructions like that, because even though AX will almost certainly contain some source
     * data prior to the instruction, the result no longer has any connection to the source.  Similarly, "SBB AX,AX"
     * may produce 0 or -1, depending on carry, but since we don't track the source of individual bits (including the
     * carry flag), AX is now source-less.  TODO: This is an argument for maintaining source info on selected flags,
     * even though it would be rather expensive.
     *
     * The 7 middle bits (9-15) record type and access information, as follows:
     *
     *      bit 15: set to indicate a "data" byte, clear to indicate a "code" byte
     *
     * All bytes start out as "data" bytes; only once they've been executed do they become "code" bytes.  For code
     * bytes, the remaining 6 middle bits (9-14) represent an execution count that starts at 1 (on the byte's initial
     * transition from data to code) and tops out at 63.
     *
     * For data bytes, the remaining middle bits indicate any transformations the data has undergone; eg:
     *
     *      bit 14: ADD/SUB/INC/DEC
     *      bit 13: MUL/DIV
     *      bit 12: OR/AND/XOR/NOT
     *
     * We make no attempt to record the original data or the transformation data, only that the transformation occurred.
     *
     * Other middle bits indicate whether the data was ever read and/or written:
     *
     *      bit 11: READ
     *      bit 10: WRITE
     *
     * Bit 9 is reserved for now.
     */
    Bus.BTINFO = {
        SLOT_MAX:       32768,
        SLOT_SHIFT:     16,
        TYPE_DATA:      0x8000,
        TYPE_ADDSUB:    0x4000,
        TYPE_MULDIV:    0x2000,
        TYPE_LOGICAL:   0x1000,
        TYPE_READ:      0x0800,
        TYPE_WRITE:     0x0400,
        TYPE_COUNT_INC: 0x0200,
        TYPE_COUNT_MAX: 0x7E00,
        TYPE_MASK:      0xFE00,
        TYPE_SHIFT:     9,
        OFF_MAX:        512,
        OFF_MASK:       0x1FF
    };
}

Bus.ERROR = {
    ADD_MEM_INUSE:      1,
    ADD_MEM_BADRANGE:   2,
    SET_MEM_NOCTRL:     3,
    SET_MEM_BADRANGE:   4,
    REM_MEM_BADRANGE:   5
};

if (NODE) module.exports = Bus;
