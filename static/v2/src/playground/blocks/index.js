// Every block the playground offers, by type.
//
// The `type` strings are stored in saved and shared graphs, so they are an
// interface: adding a block is free, renaming or removing one breaks every
// graph that uses it.

import { IqInBlock, IqPlayerBlock, SignalBlock } from './sources.js';
import { DemodulatorBlock } from './radio.js';
import { MessageLogBlock, SignalDetectorBlock } from './messages.js';
import {
    BitSyncBlock, ConsoleBlock, CostasLoopBlock, FskDetectorBlock, Ita2DecoderBlock, MorseDecoderBlock, OokDetectorBlock,
    PskSlicerBlock, SitorDecoderBlock, SymbolSyncBlock, UartBlock, VaricodeDecoderBlock, BitViewBlock,
} from './digital.js';
import { CwDecoderBlock, NavtexDecoderBlock, Psk31DecoderBlock, RttyDecoderBlock } from './decoders.js';
import { AudioDelayBlock, AudioResampleBlock, DelayBlock, ResampleBlock } from './timing.js';
import { DecimateBlock, ShiftBlock, ToAudioBlock } from './mixing.js';
import { CarrierTrackerBlock, DiscriminatorBlock, EnvelopeBlock, LowpassBlock, PowerBlock } from './detectors.js';
import {
    AudioBandpassBlock, AudioBandstopBlock, AudioHighpassBlock, AudioLowpassBlock, BiquadBlock,
    ComplexBandpassBlock, ComplexHighpassBlock, NotchBlock,
} from './filters.js';
import { AgcBlock, DcBlockerBlock, DeemphasisBlock, LevelDetectorBlock, SquelchBlock } from './levels.js';
import {
    AddBlock, ClipBlock, ComplexMultiplyBlock, ConjugateBlock, GainBlock, ImagPartBlock, MultiplyBlock, RealPartBlock, ToComplexBlock,
} from './math.js';
import {
    ControlPlotBlock, DropdownBlock, IntegratorBlock, NumberBlock, ScaleBlock, SliderBlock, ToggleBlock,
} from './controls.js';
import { AudioOutBlock, AudioSpectrumBlock, IqRecorderBlock, MeterBlock, WavRecorderBlock } from './sinks.js';
import {
    ConstellationBlock, FrequencyCounterBlock, IqPhaseMeterBlock, IqSpectrumBlock, PhaseMeterBlock, ScopeBlock,
} from './viewers.js';

export const BLOCKS = [
    IqInBlock, IqPlayerBlock, SignalBlock,
    DemodulatorBlock, RttyDecoderBlock, Psk31DecoderBlock, CwDecoderBlock, NavtexDecoderBlock,
    FskDetectorBlock, UartBlock, Ita2DecoderBlock,
    CostasLoopBlock, SymbolSyncBlock, PskSlicerBlock, VaricodeDecoderBlock,
    OokDetectorBlock, MorseDecoderBlock, BitSyncBlock, SitorDecoderBlock,
    ShiftBlock, ToAudioBlock, DecimateBlock, ResampleBlock, DelayBlock,
    LowpassBlock, ComplexHighpassBlock, ComplexBandpassBlock,
    AudioLowpassBlock, AudioHighpassBlock, AudioBandpassBlock, AudioBandstopBlock, BiquadBlock, NotchBlock,
    PowerBlock, EnvelopeBlock, DiscriminatorBlock, CarrierTrackerBlock,
    DcBlockerBlock, DeemphasisBlock, AgcBlock, AudioResampleBlock, AudioDelayBlock,
    LevelDetectorBlock, SquelchBlock,
    GainBlock, MultiplyBlock, AddBlock, ClipBlock, ComplexMultiplyBlock, ConjugateBlock, RealPartBlock, ImagPartBlock, ToComplexBlock,
    IqSpectrumBlock, AudioSpectrumBlock, ScopeBlock, ConstellationBlock, FrequencyCounterBlock,
    PhaseMeterBlock, IqPhaseMeterBlock, MeterBlock, SignalDetectorBlock, MessageLogBlock, ConsoleBlock, BitViewBlock,
    ControlPlotBlock,
    SliderBlock, NumberBlock, ToggleBlock, DropdownBlock, ScaleBlock, IntegratorBlock,
    AudioOutBlock, WavRecorderBlock, IqRecorderBlock,
];

export const BLOCK_BY_TYPE = Object.fromEntries(BLOCKS.map((b) => [b.type, b]));

/** The palette's sections, in the order a signal meets them. */
export const CATEGORIES = ['Sources', 'Radio', 'Digital', 'Mixing', 'Filters', 'Detectors', 'Audio', 'Squelch', 'Math', 'Control', 'Viewers', 'Sinks'];
