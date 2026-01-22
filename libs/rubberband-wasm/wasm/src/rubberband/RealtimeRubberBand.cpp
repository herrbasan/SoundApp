//
// Created by Tobias Hegemann on 20.09.22.
//

#include "RealtimeRubberBand.h"

#include <algorithm>

const RubberBand::RubberBandStretcher::Options kDefaultOption = RubberBand::RubberBandStretcher::OptionProcessRealTime |
  RubberBand::RubberBandStretcher::OptionPitchHighConsistency |
  RubberBand::RubberBandStretcher::OptionEngineFiner |
  RubberBand::RubberBandStretcher::OptionWindowLong;
const RubberBand::RubberBandStretcher::Options kHighQuality = RubberBand::RubberBandStretcher::OptionProcessRealTime |
  RubberBand::RubberBandStretcher::OptionPitchHighQuality |
  RubberBand::RubberBandStretcher::OptionEngineFiner |
  RubberBand::RubberBandStretcher::OptionWindowLong |
  RubberBand::RubberBandStretcher::OptionSmoothingOn;

RealtimeRubberBand::RealtimeRubberBand(size_t sampleRate, size_t channel_count, bool high_quality, bool formant_preserved, int transients, int detector, size_t block_size) :
    start_pad_samples_(0),
    start_delay_samples_(0),
  channel_count_(channel_count),
  block_size_(block_size > 0 ? block_size : 512) {
  if (sampleRate <= 0) {
    throw std::range_error("Sample rate has to be greater than 0");
  }
  if (channel_count <= 0) {
    throw std::range_error("Channel count has to be greater than 0");
  }
  
  // Build options from parameters
  RubberBand::RubberBandStretcher::Options opts = high_quality ? kHighQuality : kDefaultOption;
  
  // Add formant preservation
  if (formant_preserved) {
    opts |= RubberBand::RubberBandStretcher::OptionFormantPreserved;
  }
  
  // Add transients mode: 0=mixed, 1=crisp, 2=smooth
  if (transients == 1) {
    opts |= RubberBand::RubberBandStretcher::OptionTransientsCrisp;
  } else if (transients == 2) {
    opts |= RubberBand::RubberBandStretcher::OptionTransientsSmooth;
  } else {
    opts |= RubberBand::RubberBandStretcher::OptionTransientsMixed;
  }
  
  // Add detector mode: 0=compound, 1=percussive, 2=soft
  if (detector == 1) {
    opts |= RubberBand::RubberBandStretcher::OptionDetectorPercussive;
  } else if (detector == 2) {
    opts |= RubberBand::RubberBandStretcher::OptionDetectorSoft;
  } else {
    opts |= RubberBand::RubberBandStretcher::OptionDetectorCompound;
  }
  
  stretcher_ = new RubberBand::RubberBandStretcher(sampleRate, channel_count, opts);
  stretcher_->setMaxProcessSize(block_size_);
  output_buffer_ = new RubberBand::RingBuffer<float> *[channel_count_];
  scratch_ = new float *[channel_count_];
  // Output buffering: time ratios > 1.0 can generate output faster than we consume.
  // Give ourselves a couple seconds of headroom to avoid constant backpressure.
  buffer_size_ = std::max<size_t>(block_size_ + kReserve_ + 8192, sampleRate * 2);
  for (size_t channel = 0; channel < channel_count_; ++channel) {
    output_buffer_[channel] = new RubberBand::RingBuffer<float>(buffer_size_);
    scratch_[channel] = new float[buffer_size_];
  }
  updateRatio();
}

RealtimeRubberBand::~RealtimeRubberBand() {
  if (output_buffer_) {
    for (size_t channel = 0; channel < channel_count_; ++channel) {
      delete output_buffer_[channel];
    }
  }
  if (scratch_) {
    for (size_t channel = 0; channel < channel_count_; ++channel) {
      delete[] scratch_[channel];
    }
  }
  delete[] output_buffer_;
  delete[] scratch_;
  delete stretcher_;
}

int RealtimeRubberBand::getVersion() {
  return stretcher_->getEngineVersion();
}

void RealtimeRubberBand::setTempo(double tempo) {
  if (tempo <= 0) {
    throw std::range_error("Tempo has to be greater than 0");
  }
  if (stretcher_->getTimeRatio() != tempo) {
    fetchProcessed();
    stretcher_->setTimeRatio(tempo);
    stretcher_->setMaxProcessSize(block_size_);
    // In realtime mode we do not want to reintroduce a startup delay/pad
    // when the ratio changes. RubberBand handles ratio changes without gaps.
    start_pad_samples_ = 0;
    start_delay_samples_ = 0;
  }
}

void RealtimeRubberBand::setPitch(double pitch) {
  if (pitch <= 0) {
    throw std::range_error("Pitch has to be greater than 0");
  }
  if (stretcher_->getPitchScale() != pitch) {
    fetchProcessed();
    stretcher_->setPitchScale(pitch);
    stretcher_->setMaxProcessSize(block_size_);
    updateRatio();
  }
}

void RealtimeRubberBand::setFormantScale(double scale) {
  if (scale <= 0) {
    throw std::range_error("Format scale has to be greater than 0");
  }
  if (stretcher_->getFormantScale() != scale) {
    fetchProcessed();
    stretcher_->setFormantScale(scale);
    stretcher_->setMaxProcessSize(block_size_);
    updateRatio();
  }
}

__attribute__((unused)) size_t RealtimeRubberBand::getSamplesAvailable() {
  return output_buffer_[0]->getReadSpace();
}

void RealtimeRubberBand::push(uintptr_t input_ptr, size_t sample_size) {
  auto *input = reinterpret_cast<float *>(input_ptr); // NOLINT(performance-no-int-to-ptr)
  auto **arr_to_process = new float *[channel_count_];

  if (start_pad_samples_ > 0) {
    // Fill with start pad samples first
    auto **empty = new float *[channel_count_];
    for (size_t channel = 0; channel < channel_count_; ++channel) {
      empty[channel] = new float[start_pad_samples_];
      std::fill(empty[channel], empty[channel] + start_pad_samples_, 0.0f);
    }
    stretcher_->process(empty, start_pad_samples_, false);
    for (size_t channel = 0; channel < channel_count_; ++channel) {
      delete[] empty[channel];
    }
    delete[] empty;
    start_pad_samples_ = 0;
  }

  for (size_t channel = 0; channel < channel_count_; ++channel) {
    float *source = input + channel * sample_size;
    arr_to_process[channel] = source;
  }
  stretcher_->process(arr_to_process, sample_size, false);
  delete[] arr_to_process;
  fetchProcessed();
}

__attribute__((unused)) void RealtimeRubberBand::pull(uintptr_t output_ptr, size_t sample_size) {
  auto *output = reinterpret_cast<float *>(output_ptr); // NOLINT(performance-no-int-to-ptr)
  for (size_t channel = 0; channel < channel_count_; ++channel) {
    size_t available = output_buffer_[channel]->getReadSpace();
    float *destination = output + channel * sample_size;
    if (available == 0) {
      std::fill(destination, destination + sample_size, 0.0f);
      continue;
    }
    const size_t to_read = std::min<size_t>(available, sample_size);
    output_buffer_[channel]->read(destination, to_read);
    if (to_read < sample_size) {
      std::fill(destination + to_read, destination + sample_size, 0.0f);
    }
  }
}

void RealtimeRubberBand::fetchProcessed() {
  while (true) {
    auto available = stretcher_->available();
    if (available <= 0) return;

    // Discard start delay samples, but never retrieve more than our scratch buffer.
    if (start_delay_samples_ > 0) {
      const size_t discard = std::min<size_t>(
          std::min<size_t>(available, start_delay_samples_),
          buffer_size_
      );
      stretcher_->retrieve(scratch_, discard);
      start_delay_samples_ -= discard;
      continue;
    }

    const size_t write_space = output_buffer_[0]->getWriteSpace();
    if (write_space == 0) {
      // Output ring buffer is full. If we stop retrieving, RubberBand will buffer internally
      // and can eventually enter a bad state (silence). Drain and drop output instead.
      const size_t to_drop = std::min<size_t>(static_cast<size_t>(available), buffer_size_);
      stretcher_->retrieve(scratch_, to_drop);
      continue;
    }

    const size_t to_retrieve = std::min<size_t>(
        std::min<size_t>(available, write_space),
        buffer_size_
    );
    if (to_retrieve == 0) return;

    const size_t actual = stretcher_->retrieve(scratch_, to_retrieve);
    for (size_t channel = 0; channel < channel_count_; ++channel) {
      output_buffer_[channel]->write(scratch_[channel], actual);
    }
  }
}

void RealtimeRubberBand::updateRatio() {
  start_pad_samples_ = stretcher_->getPreferredStartPad();
  start_delay_samples_ = stretcher_->getStartDelay();
}
