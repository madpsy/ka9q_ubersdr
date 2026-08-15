import Foundation
import Darwin

/// What this app is costing the device, for the stats readout over the waterfall.
///
/// Asked for by the page once a second while that readout is open, and never
/// otherwise — see src/receiver.js and static/v2/src/lib/appStats.js. The pull
/// shape is what keeps it cheap: nothing here runs on a timer, so a receiver
/// whose operator has the readout switched off does none of this work.
///
/// The Android counterpart is AppLoad.java, and it reads /proc for both figures.
/// There is no /proc here, so both come from Mach — which is the same
/// information by a different route, and the route Instruments takes.
final class AppLoad {

    /// Processor time this process had used when last asked.
    private var lastSeconds: Double = -1
    private var lastAt: TimeInterval = 0

    /// Processor time as a share of one core, as every system monitor reports
    /// it — so an iPad with six of them can legitimately show more than 100.
    ///
    /// Summed over the threads because that is where the accounting lives:
    /// `task_info` reports only threads that have already exited, so a running
    /// app measured that way sits at zero until something ends. This adds the
    /// task's terminated-thread total to what its live threads have used.
    private func cpuPercent() -> Double? {
        var used = terminatedThreadSeconds()

        var threads: thread_act_array_t?
        var count: mach_msg_type_number_t = 0
        guard task_threads(mach_task_self_, &threads, &count) == KERN_SUCCESS,
              let threads = threads else { return nil }
        defer {
            for i in 0 ..< Int(count) { mach_port_deallocate(mach_task_self_, threads[i]) }
            vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: threads)),
                          vm_size_t(Int(count) * MemoryLayout<thread_t>.stride))
        }

        for i in 0 ..< Int(count) {
            var info = thread_basic_info()
            var size = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<natural_t>.size)
            let ok = withUnsafeMutablePointer(to: &info) {
                $0.withMemoryRebound(to: integer_t.self, capacity: Int(size)) {
                    thread_info(threads[i], thread_flavor_t(THREAD_BASIC_INFO), $0, &size)
                }
            }
            guard ok == KERN_SUCCESS, info.flags & TH_FLAGS_IDLE == 0 else { continue }
            used += Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1e6
            used += Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1e6
        }

        let now = ProcessInfo.processInfo.systemUptime
        let wasUsed = lastSeconds
        let wasAt = lastAt
        lastSeconds = used
        lastAt = now
        // A rate needs two readings. The first call answers nothing rather than
        // dividing the whole session's processor time by one second.
        guard wasUsed >= 0, now > wasAt else { return nil }
        let percent = ((used - wasUsed) / (now - wasAt)) * 100
        return percent >= 0 ? percent : nil
    }

    private func terminatedThreadSeconds() -> Double {
        var info = task_basic_info_64()
        var size = mach_msg_type_number_t(MemoryLayout<task_basic_info_64>.size / MemoryLayout<natural_t>.size)
        let ok = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(size)) {
                task_info(mach_task_self_, task_flavor_t(TASK_BASIC_INFO_64), $0, &size)
            }
        }
        guard ok == KERN_SUCCESS else { return 0 }
        return Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1e6
             + Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1e6
    }

    /// Real memory, in bytes.
    ///
    /// `phys_footprint` and not `resident_size`, because the footprint is the
    /// figure iOS itself uses: it is what counts against the app's memory limit
    /// and what the jetsam killer reads. Resident size includes pages shared
    /// with the system frameworks that this app would not give back by
    /// releasing anything, so it reads high and moves for reasons that have
    /// nothing to do with the receiver.
    private func memoryBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var size = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let ok = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(size)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &size)
            }
        }
        guard ok == KERN_SUCCESS, info.phys_footprint > 0 else { return nil }
        return UInt64(info.phys_footprint)
    }

    /// Both figures as the page's JSON, leaving out whatever could not be read.
    func json() -> String {
        var parts: [String] = []
        if let cpu = cpuPercent() { parts.append("\"cpu\":\((cpu * 10).rounded() / 10)") }
        if let mem = memoryBytes() { parts.append("\"mem\":\(mem)") }
        return "{\(parts.joined(separator: ","))}"
    }
}
