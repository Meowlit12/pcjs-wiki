/**
 * @fileoverview Implements the PC8080 CPU component.
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
    var Web = require("../../shared/lib/weblib");
    var Component = require("../../shared/lib/component");
    var State = require("../../shared/lib/state");
    var PC8080 = require("./defines");
    var CPUDef8080 = require("./cpudef");
    var CPU8080 = require("./cpu");
    var Memory8080 = require("./memory");
    var Messages8080 = require("./messages");
}

/**
 * TODO: The Closure Compiler treats ES6 classes as 'struct' rather than 'dict' by default,
 * which would force us to declare all class properties in the constructor, as well as prevent
 * us from defining any named properties.  So, for now, we mark all our classes as 'unrestricted'.
 *
 * @unrestricted
 */
class CPUState8080 extends CPU8080 {
    /**
     * CPUState8080(parmsCPU)
     *
     * The CPUState8080 class uses the following (parmsCPU) properties:
     *
     *      model: a number (eg, 8080) that should match one of the CPUDef8080.MODEL_* values
     *
     * This extends the CPU class and passes any remaining parmsCPU properties to the CPU class
     * constructor, along with a default speed (cycles per second) based on the specified (or default)
     * CPU model number.
     *
     * The CPUState8080 class was initially written to simulate a 8080 microprocessor, although over time
     * it may evolved to support other microprocessors (eg, the Zilog Z80).
     *
     * @this {CPUState8080}
     * @param {Object} parmsCPU
     */
    constructor(parmsCPU)
    {
        var nCyclesDefault = 0;
        var model = +parmsCPU['model'] || CPUDef8080.MODEL_8080;

        switch(model) {
        case CPUDef8080.MODEL_8080:
        default:
            nCyclesDefault = 1000000;
            break;
        }

        super(parmsCPU, nCyclesDefault);

        this.model = model;

        /*
         * Initialize processor operation to match the requested model
         */
        this.initProcessor();

        /*
         * A variety of stepCPU() state variables that don't strictly need to be initialized before the first
         * stepCPU() call, but it's good form to do so.
         */
        this.resetCycles();
        this.flags.complete = this.flags.debugCheck = false;

        /*
         * If there are no live registers to display, then updateStatus() can skip a bit....
         */
        this.cLiveRegs = 0;

        /*
         * Array of halt handlers, if any (see addHaltCheck)
         */
        this.afnHalt = [];
        this.addrReset = 0x0000;

        /*
         * This initial resetRegs() call is important to create all the registers, so that if/when we call restore(),
         * it will have something to fill in.
         */
        this.resetRegs();
    }

    /**
     * addHaltCheck(fn)
     *
     * Records a function that will be called during HLT opcode processing.
     *
     * @this {CPUState8080}
     * @param {function(number)} fn
     */
    addHaltCheck(fn)
    {
        this.afnHalt.push(fn);
    }

    /**
     * initProcessor()
     *
     * Interestingly, if I dynamically generate aOps as an array of functions bound to "this", using the bind()
     * method, overall performance is worse.  You would think that eliminating the need to use the call() method
     * on every opcode function invocation would be helpful, but it's not.  I'm not sure exactly why yet; perhaps
     * a Closure Compiler optimization is defeated when generating the function array at run-time instead of at
     * compile-time.
     *
     * @this {CPUState8080}
     */
    initProcessor()
    {
        this.aOps = CPUDef8080.aOps8080;
    }

    /**
     * reset()
     *
     * @this {CPUState8080}
     */
    reset()
    {
        if (this.flags.running) this.stopCPU();
        this.resetRegs();
        this.resetCycles();
        this.clearError();      // clear any fatal error/exception that setError() may have flagged
        super.reset();
    }

    /**
     * resetRegs()
     *
     * @this {CPUState8080}
     */
    resetRegs()
    {
        this.regA = 0;
        this.regB = 0;
        this.regC = 0;
        this.regD = 0;
        this.regE = 0;
        this.regH = 0;
        this.regL = 0;
        this.setSP(0);
        this.setPC(this.addrReset);

        /*
         * This resets the Processor Status flags (regPS), along with all the internal "result registers".
         */
        this.setPS(0);

        /*
         * intFlags contains some internal states we use to indicate whether a hardware interrupt (INTFLAG.INTR) or
         * Trap software interrupt (INTR.TRAP) has been requested, as well as when we're in a "HLT" state (INTFLAG.HALT)
         * that requires us to wait for a hardware interrupt (INTFLAG.INTR) before continuing execution.
         */
        this.intFlags = CPUDef8080.INTFLAG.NONE;
    }

    /**
     * setReset(addr)
     *
     * @this {CPUState8080}
     * @param {number} addr
     */
    setReset(addr)
    {
        this.addrReset = addr;
        this.setPC(addr);
    }

    /**
     * getChecksum()
     *
     * @this {CPUState8080}
     * @return {number} a 32-bit summation of key elements of the current CPU state (used by the CPU checksum code)
     */
    getChecksum()
    {
        var sum = (this.regA + this.regB + this.regC + this.regD + this.regE + this.regH + this.regL)|0;
        sum = (sum + this.getSP() + this.getPC() + this.getPS())|0;
        return sum;
    }

    /**
     * save()
     *
     * This implements save support for the CPUState8080 component.
     *
     * @this {CPUState8080}
     * @return {Object|null}
     */
    save()
    {
        var state = new State(this);
        state.set(0, [this.regA, this.regB, this.regC, this.regD, this.regE, this.regH, this.regL, this.getSP(), this.getPC(), this.getPS()]);
        state.set(1, [this.intFlags, this.nTotalCycles, this.getSpeed()]);
        state.set(2, this.bus.saveMemory());
        return state.data();
    }

    /**
     * restore(data)
     *
     * This implements restore support for the CPUState8080 component.
     *
     * @this {CPUState8080}
     * @param {Object} data
     * @return {boolean} true if restore successful, false if not
     */
    restore(data)
    {
        var a = data[0];
        this.regA = a[0];
        this.regB = a[1];
        this.regC = a[2];
        this.regD = a[3];
        this.regE = a[4];
        this.regH = a[5];
        this.regL = a[6];
        this.setSP(a[7]);
        this.setPC(a[8]);
        this.setPS(a[9]);
        a = data[1];
        this.intFlags = a[0];
        this.nTotalCycles = a[1];
        this.setSpeed(a[3]);
        return this.bus.restoreMemory(data[2]);
    }

    /**
     * setBinding(sHTMLType, sBinding, control, sValue)
     *
     * @this {CPUState8080}
     * @param {string|null} sHTMLType is the type of the HTML control (eg, "button", "list", "text", "submit", "textarea", "canvas")
     * @param {string} sBinding is the value of the 'binding' parameter stored in the HTML control's "data-value" attribute (eg, "AX")
     * @param {Object} control is the HTML control DOM object (eg, HTMLButtonElement)
     * @param {string} [sValue] optional data value
     * @return {boolean} true if binding was successful, false if unrecognized binding request
     */
    setBinding(sHTMLType, sBinding, control, sValue)
    {
        var fBound = false;
        switch (sBinding) {
        case "A":
        case "B":
        case "C":
        case "BC":
        case "D":
        case "E":
        case "DE":
        case "H":
        case "L":
        case "HL":
        case "SP":
        case "PC":
        case "PS":
        case "IF":
        case "SF":
        case "ZF":
        case "AF":
        case "PF":
        case "CF":
            this.bindings[sBinding] = control;
            this.cLiveRegs++;
            fBound = true;
            break;
        default:
            fBound = super.setBinding(sHTMLType, sBinding, control);
            break;
        }
        return fBound;
    }

    /**
     * getBC()
     *
     * @this {CPUState8080}
     * @return {number}
     */
    getBC()
    {
        return (this.regB << 8) | this.regC;
    }

    /**
     * setBC(w)
     *
     * @this {CPUState8080}
     * @param {number} w
     */
    setBC(w)
    {
        this.regB = (w >> 8) & 0xff;
        this.regC = w & 0xff;
    }

    /**
     * getDE()
     *
     * @this {CPUState8080}
     * @return {number}
     */
    getDE()
    {
        return (this.regD << 8) | this.regE;
    }

    /**
     * setDE(w)
     *
     * @this {CPUState8080}
     * @param {number} w
     */
    setDE(w)
    {
        this.regD = (w >> 8) & 0xff;
        this.regE = w & 0xff;
    }

    /**
     * getHL()
     *
     * @this {CPUState8080}
     * @return {number}
     */
    getHL()
    {
        return (this.regH << 8) | this.regL;
    }

    /**
     * setHL(w)
     *
     * @this {CPUState8080}
     * @param {number} w
     */
    setHL(w)
    {
        this.regH = (w >> 8) & 0xff;
        this.regL = w & 0xff;
    }

    /**
     * getSP()
     *
     * @this {CPUState8080}
     * @return {number}
     */
    getSP()
    {
        return this.regSP;
    }

    /**
     * setSP(off)
     *
     * @this {CPUState8080}
     * @param {number} off
     */
    setSP(off)
    {
        this.regSP = off & 0xffff;
    }

    /**
     * getPC()
     *
     * @this {CPUState8080}
     * @return {number}
     */
    getPC()
    {
        return this.regPC;
    }

    /**
     * offPC()
     *
     * @this {CPUState8080}
     * @param {number} off
     * @return {number}
     */
    offPC(off)
    {
        return (this.regPC + off) & 0xffff;
    }

    /**
     * setPC(off)
     *
     * @this {CPUState8080}
     * @param {number} off
     */
    setPC(off)
    {
        this.regPC = off & 0xffff;
    }

    /**
     * clearCF()
     *
     * @this {CPUState8080}
     */
    clearCF()
    {
        this.resultZeroCarry &= 0xff;
    }

    /**
     * getCF()
     *
     * @this {CPUState8080}
     * @return {number} 0 or 1 (CPUDef8080.PS.CF)
     */
    getCF()
    {
        return (this.resultZeroCarry & 0x100)? CPUDef8080.PS.CF : 0;
    }

    /**
     * setCF()
     *
     * @this {CPUState8080}
     */
    setCF()
    {
        this.resultZeroCarry |= 0x100;
    }

    /**
     * updateCF(CF)
     *
     * @this {CPUState8080}
     * @param {number} CF (0x000 or 0x100)
     */
    updateCF(CF)
    {
        this.resultZeroCarry = (this.resultZeroCarry & 0xff) | CF;
    }

    /**
     * clearPF()
     *
     * @this {CPUState8080}
     */
    clearPF()
    {
        if (this.getPF()) this.resultParitySign ^= 0x1;
    }

    /**
     * getPF()
     *
     * @this {CPUState8080}
     * @return {number} 0 or CPUDef8080.PS.PF
     */
    getPF()
    {
        return (CPUDef8080.PARITY[this.resultParitySign & 0xff])? CPUDef8080.PS.PF : 0;
    }

    /**
     * setPF()
     *
     * @this {CPUState8080}
     */
    setPF()
    {
        if (!this.getPF()) this.resultParitySign ^= 0x1;
    }

    /**
     * clearAF()
     *
     * @this {CPUState8080}
     */
    clearAF()
    {
        this.resultAuxOverflow = (this.resultParitySign & 0x10) | (this.resultAuxOverflow & ~0x10);
    }

    /**
     * getAF()
     *
     * @this {CPUState8080}
     * @return {number} 0 or CPUDef8080.PS.AF
     */
    getAF()
    {
        return ((this.resultParitySign ^ this.resultAuxOverflow) & 0x10)? CPUDef8080.PS.AF : 0;
    }

    /**
     * setAF()
     *
     * @this {CPUState8080}
     */
    setAF()
    {
        this.resultAuxOverflow = (~this.resultParitySign & 0x10) | (this.resultAuxOverflow & ~0x10);
    }

    /**
     * clearZF()
     *
     * @this {CPUState8080}
     */
    clearZF()
    {
        this.resultZeroCarry |= 0xff;
    }

    /**
     * getZF()
     *
     * @this {CPUState8080}
     * @return {number} 0 or CPUDef8080.PS.ZF
     */
    getZF()
    {
        return (this.resultZeroCarry & 0xff)? 0 : CPUDef8080.PS.ZF;
    }

    /**
     * setZF()
     *
     * @this {CPUState8080}
     */
    setZF()
    {
        this.resultZeroCarry &= ~0xff;
    }

    /**
     * clearSF()
     *
     * @this {CPUState8080}
     */
    clearSF()
    {
        if (this.getSF()) this.resultParitySign ^= 0xc0;
    }

    /**
     * getSF()
     *
     * @this {CPUState8080}
     * @return {number} 0 or CPUDef8080.PS.SF
     */
    getSF()
    {
        return (this.resultParitySign & 0x80)? CPUDef8080.PS.SF : 0;
    }

    /**
     * setSF()
     *
     * @this {CPUState8080}
     */
    setSF()
    {
        if (!this.getSF()) this.resultParitySign ^= 0xc0;
    }

    /**
     * clearIF()
     *
     * @this {CPUState8080}
     */
    clearIF()
    {
        this.regPS &= ~CPUDef8080.PS.IF;
    }

    /**
     * getIF()
     *
     * @this {CPUState8080}
     * @return {number} 0 or CPUDef8080.PS.IF
     */
    getIF()
    {
        return (this.regPS & CPUDef8080.PS.IF);
    }

    /**
     * setIF()
     *
     * @this {CPUState8080}
     */
    setIF()
    {
        this.regPS |= CPUDef8080.PS.IF;
    }

    /**
     * getPS()
     *
     * @this {CPUState8080}
     * @return {number}
     */
    getPS()
    {
        return (this.regPS & ~CPUDef8080.PS.RESULT) | (this.getSF() | this.getZF() | this.getAF() | this.getPF() | this.getCF());
    }

    /**
     * setPS(regPS)
     *
     * @this {CPUState8080}
     * @param {number} regPS
     */
    setPS(regPS)
    {
        this.resultZeroCarry = this.resultParitySign = this.resultAuxOverflow = 0;
        if (regPS & CPUDef8080.PS.CF) this.resultZeroCarry |= 0x100;
        if (!(regPS & CPUDef8080.PS.PF)) this.resultParitySign |= 0x01;
        if (regPS & CPUDef8080.PS.AF) this.resultAuxOverflow |= 0x10;
        if (!(regPS & CPUDef8080.PS.ZF)) this.resultZeroCarry |= 0xff;
        if (regPS & CPUDef8080.PS.SF) this.resultParitySign ^= 0xc0;
        this.regPS = (this.regPS & ~(CPUDef8080.PS.RESULT | CPUDef8080.PS.INTERNAL)) | (regPS & CPUDef8080.PS.INTERNAL) | CPUDef8080.PS.SET;
        Component.assert((regPS & CPUDef8080.PS.RESULT) == (this.getPS() & CPUDef8080.PS.RESULT));
    }

    /**
     * getPSW()
     *
     * @this {CPUState8080}
     * @return {number}
     */
    getPSW()
    {
        return (this.getPS() & CPUDef8080.PS.MASK) | (this.regA << 8);
    }

    /**
     * setPSW(w)
     *
     * @this {CPUState8080}
     * @param {number} w
     */
    setPSW(w)
    {
        this.setPS((w & CPUDef8080.PS.MASK) | (this.regPS & ~CPUDef8080.PS.MASK));
        this.regA = w >> 8;
    }

    /**
     * addByte(src)
     *
     * @this {CPUState8080}
     * @param {number} src
     * @return {number} regA + src
     */
    addByte(src)
    {
        this.resultAuxOverflow = this.regA ^ src;
        return this.resultParitySign = (this.resultZeroCarry = this.regA + src) & 0xff;
    }

    /**
     * addByteCarry(src)
     *
     * @this {CPUState8080}
     * @param {number} src
     * @return {number} regA + src + carry
     */
    addByteCarry(src)
    {
        this.resultAuxOverflow = this.regA ^ src;
        return this.resultParitySign = (this.resultZeroCarry = this.regA + src + ((this.resultZeroCarry & 0x100)? 1 : 0)) & 0xff;
    }

    /**
     * andByte(src)
     *
     * Ordinarily, one would expect the Auxiliary Carry flag (AF) to be clear after this operation,
     * but apparently the 8080 will set AF if bit 3 in either operand is set.
     *
     * @this {CPUState8080}
     * @param {number} src
     * @return {number} regA & src
     */
    andByte(src)
    {
        this.resultZeroCarry = this.resultParitySign = this.resultAuxOverflow = this.regA & src;
        if ((this.regA | src) & 0x8) this.resultAuxOverflow ^= 0x10;        // set AF by inverting bit 4 in resultAuxOverflow
        return this.resultZeroCarry;
    }

    /**
     * decByte(b)
     *
     * We perform this operation using 8-bit two's complement arithmetic, by negating and then adding
     * the implied src of 1.  This appears to mimic how the 8080 manages the Auxiliary Carry flag (AF).
     *
     * @this {CPUState8080}
     * @param {number} b
     * @return {number}
     */
    decByte(b)
    {
        this.resultAuxOverflow = b ^ 0xff;
        b = this.resultParitySign = (b + 0xff) & 0xff;
        this.resultZeroCarry = (this.resultZeroCarry & ~0xff) | b;
        return b;
    }

    /**
     * incByte(b)
     *
     * @this {CPUState8080}
     * @param {number} b
     * @return {number}
     */
    incByte(b)
    {
        this.resultAuxOverflow = b;
        b = this.resultParitySign = (b + 1) & 0xff;
        this.resultZeroCarry = (this.resultZeroCarry & ~0xff) | b;
        return b;
    }

    /**
     * orByte(src)
     *
     * @this {CPUState8080}
     * @param {number} src
     * @return {number} regA | src
     */
    orByte(src)
    {
        return this.resultParitySign = this.resultZeroCarry = this.resultAuxOverflow = this.regA | src;
    }

    /**
     * subByte(src)
     *
     * We perform this operation using 8-bit two's complement arithmetic, by inverting src, adding
     * src + 1, and then inverting the resulting carry (resultZeroCarry ^ 0x100).  This appears to mimic
     * how the 8080 manages the Auxiliary Carry flag (AF).
     *
     * This function is also used as a cmpByte() function; compare instructions simply ignore the
     * return value.
     *
     * Example: A=66, SUI $10
     *
     * If we created the two's complement of 0x10 by negating it, there would just be one addition:
     *
     *      0110 0110   (0x66)
     *    + 1111 0000   (0xF0)  (ie, -0x10)
     *      ---------
     *    1 0101 0110   (0x56)
     *
     * But in order to mimic the 8080's AF flag, we must perform the two's complement of src in two steps,
     * inverting it before the add, and then incrementing after the add; eg:
     *
     *      0110 0110   (0x66)
     *    + 1110 1111   (0xEF)  (ie, ~0x10)
     *      ---------
     *    1 0101 0101   (0x55)
     *    + 0000 0001   (0x01)
     *      ---------
     *    1 0101 0110   (0x56)
     *
     * @this {CPUState8080}
     * @param {number} src
     * @return {number} regA - src
     */
    subByte(src)
    {
        src ^= 0xff;
        this.resultAuxOverflow = this.regA ^ src;
        return this.resultParitySign = (this.resultZeroCarry = (this.regA + src + 1) ^ 0x100) & 0xff;
    }

    /**
     * subByteBorrow(src)
     *
     * We perform this operation using 8-bit two's complement arithmetic, using logic similar to subByte(),
     * but changing the final increment to a conditional increment, because if the Carry flag (CF) is set, then
     * we don't need to perform the increment at all.
     *
     * This mimics the behavior of subByte() when the Carry flag (CF) is clear, and hopefully also mimics how the
     * 8080 manages the Auxiliary Carry flag (AF) when the Carry flag (CF) is set.
     *
     * @this {CPUState8080}
     * @param {number} src
     * @return {number} regA - src - carry
     */
    subByteBorrow(src)
    {
        src ^= 0xff;
        this.resultAuxOverflow = this.regA ^ src;
        return this.resultParitySign = (this.resultZeroCarry = (this.regA + src + ((this.resultZeroCarry & 0x100)? 0 : 1)) ^ 0x100) & 0xff;
    }

    /**
     * xorByte(src)
     *
     * @this {CPUState8080}
     * @param {number} src
     * @return {number} regA ^ src
     */
    xorByte(src)
    {
        return this.resultParitySign = this.resultZeroCarry = this.resultAuxOverflow = this.regA ^ src;
    }

    /**
     * getByte(addr)
     *
     * @this {CPUState8080}
     * @param {number} addr is a linear address
     * @return {number} byte (8-bit) value at that address
     */
    getByte(addr)
    {
        return this.bus.getByte(addr);
    }

    /**
     * getWord(addr)
     *
     * @this {CPUState8080}
     * @param {number} addr is a linear address
     * @return {number} word (16-bit) value at that address
     */
    getWord(addr)
    {
        return this.bus.getShort(addr);
    }

    /**
     * setByte(addr, b)
     *
     * @this {CPUState8080}
     * @param {number} addr is a linear address
     * @param {number} b is the byte (8-bit) value to write (which we truncate to 8 bits; required by opSTOSb)
     */
    setByte(addr, b)
    {
        this.bus.setByte(addr, b);
    }

    /**
     * setWord(addr, w)
     *
     * @this {CPUState8080}
     * @param {number} addr is a linear address
     * @param {number} w is the word (16-bit) value to write (which we truncate to 16 bits to be safe)
     */
    setWord(addr, w)
    {
        this.bus.setShort(addr, w);
    }

    /**
     * getPCByte()
     *
     * @this {CPUState8080}
     * @return {number} byte at the current PC; PC advanced by 1
     */
    getPCByte()
    {
        var b = this.getByte(this.regPC);
        this.setPC(this.regPC + 1);
        return b;
    }

    /**
     * getPCWord()
     *
     * @this {CPUState8080}
     * @return {number} word at the current PC; PC advanced by 2
     */
    getPCWord()
    {
        var w = this.getWord(this.regPC);
        this.setPC(this.regPC + 2);
        return w;
    }

    /**
     * popWord()
     *
     * @this {CPUState8080}
     * @return {number} word popped from the current SP; SP increased by 2
     */
    popWord()
    {
        var w = this.getWord(this.regSP);
        this.setSP(this.regSP + 2);
        return w;
    }

    /**
     * pushWord(w)
     *
     * @this {CPUState8080}
     * @param {number} w is the word (16-bit) value to push at current SP; SP decreased by 2
     */
    pushWord(w)
    {
        this.setSP(this.regSP - 2);
        this.setWord(this.regSP, w);
    }

    /**
     * checkINTR()
     *
     * @this {CPUState8080}
     * @return {boolean} true if execution may proceed, false if not
     */
    checkINTR()
    {
        /*
         * If the Debugger is single-stepping, this.nStepCycles will always be zero, which we take
         * advantage of here to avoid processing interrupts.  The Debugger will have to issue a "g"
         * command (or "p" command on a call instruction) if you want interrupts to be processed.
         */
        if (this.nStepCycles) {
            if ((this.intFlags & CPUDef8080.INTFLAG.INTR) && this.getIF()) {
                for (var nLevel = 0; nLevel < 8; nLevel++) {
                    if (this.intFlags & (1 << nLevel)) break;
                }
                this.clearINTR(nLevel);
                this.clearIF();
                this.intFlags &= ~CPUDef8080.INTFLAG.HALT;
                this.aOps[CPUDef8080.OPCODE.RST0 | (nLevel << 3)].call(this);
            }
        }
        if (this.intFlags & CPUDef8080.INTFLAG.HALT) {
            /*
             * As discussed in opHLT(), the CPU is never REALLY halted by a HLT instruction; instead, opHLT()
             * calls requestHALT(), which sets INTFLAG.HALT and signals to stepCPU() that it's free to end the
             * current burst AND that it should not execute any more instructions until checkINTR() indicates
             * that a hardware interrupt has been requested.
             */
            this.endBurst();
            return false;
        }
        return true;
    }

    /**
     * clearINTR(nLevel)
     *
     * Clear the corresponding interrupt level.
     *
     * nLevel can either be a valid interrupt level (0-7), or -1 to clear all pending interrupts
     * (eg, in the event of a system-wide reset).
     *
     * @this {CPUState8080}
     * @param {number} nLevel (0-7, or -1 for all)
     */
    clearINTR(nLevel)
    {
        var bitsClear = nLevel < 0? 0xff : (1 << nLevel);
        this.intFlags &= ~bitsClear;
    }

    /**
     * requestHALT()
     *
     * @this {CPUState8080}
     */
    requestHALT()
    {
        this.intFlags |= CPUDef8080.INTFLAG.HALT;
        this.endBurst();
    }

    /**
     * requestINTR(nLevel)
     *
     * Request the corresponding interrupt level.
     *
     * Each interrupt level (0-7) has its own intFlags bit (0-7).  If the Interrupt Flag (IF) is also
     * set, then we know that checkINTR() will want to issue the interrupt, so we end the current burst
     * by setting nStepCycles to zero.  But before we do, we subtract nStepCycles from nBurstCycles,
     * so that the calculation of how many cycles were actually executed on this burst is correct.
     *
     * @this {CPUState8080}
     * @param {number} nLevel (0-7)
     */
    requestINTR(nLevel)
    {
        this.intFlags |= (1 << nLevel);
        if (this.getIF()) {
            this.endBurst();
        }
    }

    /**
     * updateReg(sReg, nValue, cch)
     *
     * This function helps updateStatus() by massaging the register names and values according to
     * CPU type before passing the call to displayValue(); in the "old days", updateStatus() called
     * displayValue() directly (although then it was called displayReg()).
     *
     * @this {CPUState8080}
     * @param {string} sReg
     * @param {number} nValue
     * @param {number} [cch] (default is 2 hex digits)
     */
    updateReg(sReg, nValue, cch)
    {
        this.displayValue(sReg, nValue, cch || 2);
    }

    /**
     * updateStatus(fForce)
     *
     * This provides periodic Control Panel updates (eg, a few times per second; see YIELDS_PER_STATUS).
     * this is where we take care of any DOM updates (eg, register values) while the CPU is running.
     *
     * Any high-frequency updates should be performed in updateVideo(), which should avoid DOM updates,
     * since updateVideo() can be called up to 60 times per second.
     *
     * @this {CPUState8080}
     * @param {boolean} [fForce] (true will display registers even if the CPU is running and "live" registers are not enabled)
     */
    updateStatus(fForce)
    {
        if (this.cLiveRegs) {
            if (fForce || !this.flags.running || this.flags.displayLiveRegs) {
                this.updateReg("A", this.regA);
                this.updateReg("B", this.regB);
                this.updateReg("C", this.regC);
                this.updateReg("BC", this.getBC(), 4);
                this.updateReg("D", this.regD);
                this.updateReg("E", this.regE);
                this.updateReg("DE", this.getDE(), 4);
                this.updateReg("H", this.regH);
                this.updateReg("L", this.regL);
                this.updateReg("HL", this.getHL(), 4);
                this.updateReg("SP", this.getSP(), 4);
                this.updateReg("PC", this.getPC(), 4);
                var regPS = this.getPS();
                this.updateReg("PS", regPS, 4);
                this.updateReg("IF", (regPS & CPUDef8080.PS.IF)? 1 : 0, 1);
                this.updateReg("SF", (regPS & CPUDef8080.PS.SF)? 1 : 0, 1);
                this.updateReg("ZF", (regPS & CPUDef8080.PS.ZF)? 1 : 0, 1);
                this.updateReg("AF", (regPS & CPUDef8080.PS.AF)? 1 : 0, 1);
                this.updateReg("PF", (regPS & CPUDef8080.PS.PF)? 1 : 0, 1);
                this.updateReg("CF", (regPS & CPUDef8080.PS.CF)? 1 : 0, 1);
            }
        }
        var controlSpeed = this.bindings["speed"];
        if (controlSpeed) controlSpeed.textContent = this.getSpeedCurrent();
    }

    /**
     * stepCPU(nMinCycles)
     *
     * NOTE: Single-stepping should not be confused with the Trap flag; single-stepping is a Debugger
     * operation that's completely independent of Trap status.  The CPU can go in and out of Trap mode,
     * in and out of h/w interrupt service routines (ISRs), etc, but from the Debugger's perspective,
     * they're all one continuous stream of instructions that can be stepped or run at will.  Moreover,
     * stepping vs. running should never change the behavior of the simulation.
     *
     * @this {CPUState8080}
     * @param {number} nMinCycles (0 implies a single-step, and therefore breakpoints should be ignored)
     * @return {number} of cycles executed; 0 indicates a pre-execution condition (ie, an execution breakpoint
     * was hit), -1 indicates a post-execution condition (eg, a read or write breakpoint was hit), and a positive
     * number indicates successful completion of that many cycles (which should always be >= nMinCycles).
     */
    stepCPU(nMinCycles)
    {
        /*
         * The Debugger uses fComplete to determine if the instruction completed (true) or was interrupted
         * by a breakpoint or some other exceptional condition (false).  NOTE: this does NOT include JavaScript
         * exceptions, which stepCPU() expects the caller to catch using its own exception handler.
         *
         * The CPU relies on the use of stopCPU() rather than fComplete, because the CPU never single-steps
         * (ie, nMinCycles is always some large number), whereas the Debugger does.  And conversely, when the
         * Debugger is single-stepping (even when performing multiple single-steps), fRunning is never set,
         * so stopCPU() would have no effect as far as the Debugger is concerned.
         */
        this.flags.complete = true;

        /*
         * fDebugCheck is true if we need to "check" every instruction with the Debugger.
         */
        var fDebugCheck = this.flags.debugCheck = (DEBUGGER && this.dbg && this.dbg.checksEnabled());

        /*
         * nDebugState is checked only when fDebugCheck is true, and its sole purpose is to tell the first call
         * to checkInstruction() that it can skip breakpoint checks, and that will be true ONLY when fStarting is
         * true OR nMinCycles is zero (the latter means the Debugger is single-stepping).
         *
         * Once we snap fStarting, we clear it, because technically, we've moved beyond "starting" and have
         * officially "started" now.
         */
        var nDebugState = (!nMinCycles)? -1 : (this.flags.starting? 0 : 1);
        this.flags.starting = false;

        /*
         * We move the minimum cycle count to nStepCycles (the number of cycles left to step), so that other
         * functions have the ability to force that number to zero (eg, stopCPU()), and thus we don't have to check
         * any other criteria to determine whether we should continue stepping or not.
         */
        this.nBurstCycles = this.nStepCycles = nMinCycles;

        /*
         * NOTE: If checkINTR() returns false, INTFLAG.HALT must be set, so no instructions should be executed.
         */
        if (this.checkINTR()) {
            do {
                if (DEBUGGER && fDebugCheck) {
                    if (this.dbg.checkInstruction(this.regPC, nDebugState)) {
                        this.stopCPU();
                        break;
                    }
                    nDebugState = 1;
                }
                this.aOps[this.getPCByte()].call(this);

            } while (this.nStepCycles > 0);
        }

        return (this.flags.complete? this.nBurstCycles - this.nStepCycles : (this.flags.complete === undefined? 0 : -1));
    }

    /**
     * CPUState8080.init()
     *
     * This function operates on every HTML element of class "cpu", extracting the
     * JSON-encoded parameters for the CPUState8080 constructor from the element's "data-value"
     * attribute, invoking the constructor (which in turn invokes the CPU constructor)
     * to create a CPUState8080 component, and then binding any associated HTML controls to the
     * new component.
     */
    static init()
    {
        var aeCPUs = Component.getElementsByClass(document, PC8080.APPCLASS, "cpu");
        for (var iCPU = 0; iCPU < aeCPUs.length; iCPU++) {
            var eCPU = aeCPUs[iCPU];
            var parmsCPU = Component.getComponentParms(eCPU);
            var cpu = new CPUState8080(parmsCPU);
            Component.bindComponentControls(cpu, eCPU, PC8080.APPCLASS);
        }
    }
}

/*
 * Initialize every CPU module on the page
 */
Web.onInit(CPUState8080.init);

if (NODE) module.exports = CPUState8080;
