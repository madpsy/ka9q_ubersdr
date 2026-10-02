// Every block the playground offers, by type.
//
// The `type` strings are stored in saved and shared graphs, so they are an
// interface: adding a block is free, renaming or removing one breaks every
// graph that uses it.

import { DataTransmitterBlock, IqInBlock, IqPlayerBlock, SignalBlock } from './sources.js';
import { DemodulatorBlock } from './radio.js';
import { MessageLogBlock, SignalDetectorBlock } from './messages.js';
import {
    BitSyncBlock, ConsoleBlock, CostasLoopBlock, FskDetectorBlock, Ita2DecoderBlock, MorseDecoderBlock, OokDetectorBlock,
    PskSlicerBlock, SitorDecoderBlock, SymbolSyncBlock, UartBlock, VaricodeDecoderBlock, BitViewBlock, TextDiffBlock,
    MorseEncoderBlock,
} from './digital.js';
import {
    CwDecoderBlock, DominoexDecoderBlock, MfskDecoderBlock, NavtexDecoderBlock, OliviaDecoderBlock, Psk31DecoderBlock, RttyDecoderBlock, SstvBlock, ThorDecoderBlock, WefaxBlock,
} from './decoders.js';
import { AudioDelayBlock, AudioResampleBlock, DelayBlock, ResampleBlock } from './timing.js';
import { DecimateBlock, ShiftBlock, ToAudioBlock } from './mixing.js';
import { CarrierTrackerBlock, DiscriminatorBlock, EnvelopeBlock, LowpassBlock, PowerBlock } from './detectors.js';
import {
    AudioBandpassBlock, AudioBandstopBlock, AudioHighpassBlock, AudioLowpassBlock, BiquadBlock,
    ComplexBandpassBlock, ComplexHighpassBlock, NotchBlock,
} from './filters.js';
import { AgcBlock, CompressorBlock, DcBlockerBlock, DeemphasisBlock, LevelDetectorBlock, SquelchBlock } from './levels.js';
import { GraphicEqBlock, ParametricEqBlock } from './eq.js';
import { LsaBlock, NoiseBlankerBlock, Nr2Block } from './noise.js';
import {
    AddBlock, ClipBlock, ThresholdBlock, ComplexMultiplyBlock, ConjugateBlock, GainBlock, ImagPartBlock, MultiplyBlock, RealPartBlock, ToComplexBlock,
} from './math.js';
import {
    ControlPlotBlock, DropdownBlock, IntegratorBlock, NumberBlock, ScaleBlock, ShapeBlock, SliderBlock, ToggleBlock,
} from './controls.js';
import { AudioOutBlock, AudioSpectrumBlock, IqRecorderBlock, MeterBlock, TtsBlock, WavRecorderBlock } from './sinks.js';
import { ANNOTATIONS } from './annotate.js';
import {
    ConstellationBlock, FrequencyCounterBlock, IqPhaseMeterBlock, IqSpectrumBlock, PhaseMeterBlock, ScopeBlock, IntervalCounterBlock, StripChartBlock, HistogramBlock, ReadoutBlock,
} from './viewers.js';

import { SerialPortBlock } from './serial.js';
import { ClockBlock } from './clock.js';
import { PulseClassifierBlock } from './pulse.js';
import { TimecodeBlock } from './timecode.js';
import {
    DifferentiatorBlock, IntegrateDumpBlock, KeepOneInNBlock, MovingAverageBlock, NoiseSourceBlock, PhaseBlock, SampleHoldBlock, SelectorBlock,
} from './stream.js';
import { HilbertBlock, MatchedFilterAudioBlock, MatchedFilterBlock } from './shaping.js';
import { DscBlock } from './dsc.js';
import { BytesTextBlock, CrcCheckBlock, PackBitsBlock, SyncFramerBlock, UnpackBitsBlock } from './bits.js';
import { ConvEncoderBlock, SoftViterbiBlock, ViterbiBlock } from './fec.js';
import {
    DominoVaricodeBlock, IfkDecoderBlock, MfskDemapperBlock, MfskDetectorBlock, MfskInterleaverBlock, MfskVaricodeBlock, OliviaFecBlock,
} from './mfsk.js';
import { CorrelatorBlock, EqualiserBlock, FllBandEdgeBlock, GoertzelBlock } from './sync.js';
import { BeaconMonitorBlock } from './beacons.js';
import { FrequencyListBlock, SchedulerBlock } from './scheduler.js';
import { StatusBlock } from './status.js';
import { HellBlock, ImageViewerBlock } from './imaging.js';
import { SstvDemodBlock, SstvRasterBlock } from './sstvstages.js';
import { FaxRasterBlock } from './fax.js';
import { HfChannelBlock } from './channel.js';

export const BLOCKS = [
    IqInBlock, IqPlayerBlock, SignalBlock, DataTransmitterBlock, ClockBlock,
    DemodulatorBlock, RttyDecoderBlock, Psk31DecoderBlock, CwDecoderBlock, NavtexDecoderBlock,
    OliviaDecoderBlock, MfskDecoderBlock, DominoexDecoderBlock, ThorDecoderBlock,
    FskDetectorBlock, UartBlock, Ita2DecoderBlock,
    CostasLoopBlock, SymbolSyncBlock, PskSlicerBlock, VaricodeDecoderBlock,
    OokDetectorBlock, MorseDecoderBlock, MorseEncoderBlock, BitSyncBlock, SitorDecoderBlock,
    ShiftBlock, ToAudioBlock, DecimateBlock, ResampleBlock, DelayBlock,
    LowpassBlock, ComplexHighpassBlock, ComplexBandpassBlock,
    AudioLowpassBlock, AudioHighpassBlock, AudioBandpassBlock, AudioBandstopBlock, BiquadBlock, NotchBlock,
    NoiseBlankerBlock, LsaBlock, Nr2Block,
    PowerBlock, EnvelopeBlock, DiscriminatorBlock, CarrierTrackerBlock,
    DcBlockerBlock, DeemphasisBlock, AgcBlock, CompressorBlock, GraphicEqBlock, ParametricEqBlock, AudioResampleBlock, AudioDelayBlock,
    LevelDetectorBlock, SquelchBlock,
    GainBlock, MultiplyBlock, AddBlock, ClipBlock, ThresholdBlock, ComplexMultiplyBlock, ConjugateBlock, RealPartBlock, ImagPartBlock, ToComplexBlock,
    IqSpectrumBlock, AudioSpectrumBlock, ScopeBlock, StripChartBlock, HistogramBlock, ReadoutBlock, IntervalCounterBlock, ConstellationBlock, FrequencyCounterBlock,
    PhaseMeterBlock, IqPhaseMeterBlock, MeterBlock, SignalDetectorBlock, MessageLogBlock, ConsoleBlock, TextDiffBlock, BitViewBlock,
    ControlPlotBlock,
    SliderBlock, NumberBlock, ToggleBlock, DropdownBlock, ScaleBlock, ShapeBlock, IntegratorBlock,
    AudioOutBlock, WavRecorderBlock, IqRecorderBlock, TtsBlock,
    SerialPortBlock,
    PulseClassifierBlock,
    TimecodeBlock,
    PhaseBlock, MovingAverageBlock, IntegrateDumpBlock, DifferentiatorBlock, SampleHoldBlock, KeepOneInNBlock, SelectorBlock, NoiseSourceBlock,
    MatchedFilterBlock, MatchedFilterAudioBlock, HilbertBlock,
    DscBlock, PackBitsBlock, UnpackBitsBlock, SyncFramerBlock, CrcCheckBlock, BytesTextBlock, ConvEncoderBlock, ViterbiBlock, SoftViterbiBlock, FllBandEdgeBlock, CorrelatorBlock, GoertzelBlock, EqualiserBlock, BeaconMonitorBlock, SchedulerBlock, FrequencyListBlock, StatusBlock,
    MfskDetectorBlock, MfskDemapperBlock, IfkDecoderBlock, MfskInterleaverBlock, MfskVaricodeBlock, DominoVaricodeBlock, OliviaFecBlock,
    ImageViewerBlock, HellBlock, WefaxBlock, FaxRasterBlock, SstvBlock, SstvDemodBlock, SstvRasterBlock, HfChannelBlock,
    // Not in the palette: the toolbar adds them (see CATEGORIES).
    ...ANNOTATIONS,
];

export const BLOCK_BY_TYPE = Object.fromEntries(BLOCKS.map((b) => [b.type, b]));

/** The palette's sections, in the order a signal meets them. Annotations are added from the toolbar instead. */
export const CATEGORIES = ['Sources', 'Radio', 'Digital', 'Mixing', 'Filters', 'Detectors', 'Audio', 'Squelch', 'Math', 'Control', 'Viewers', 'Sinks', 'Devices'];
